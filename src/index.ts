import 'dotenv/config';
import { Telegraf } from 'telegraf';
import pino from 'pino';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  TELEGRAM_BOT_TOKEN,
  DATA_DIR,
  TRIGGER_PATTERN,
  MAIN_GROUP_FOLDER,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  TIMEZONE
} from './config.js';
import { RegisteredGroup, Session, NewMessage } from './types.js';
import { initDatabase, storeMessage, storeChatMetadata, getMessagesSince, getAllTasks, getTaskById, updateChatName, getAllChats, getLastGroupSync, setLastGroupSync } from './db.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { runContainerAgent, writeTasksSnapshot, writeGroupsSnapshot, AvailableGroup } from './container-runner.js';
import { loadJson, saveJson } from './utils.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

let bot: Telegraf;
let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};

// Track which chats have an agent currently running (prevent concurrent runs)
const activeAgentChats = new Set<string>();

async function setTyping(chatId: string): Promise<void> {
  try {
    await bot.telegram.sendChatAction(chatId, 'typing');
  } catch (err) {
    logger.debug({ chatId, err }, 'Failed to send typing action');
  }
}

function loadState(): void {
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const state = loadJson<{ last_agent_timestamp?: Record<string, string> }>(statePath, {});
  lastAgentTimestamp = state.last_agent_timestamp || {};
  sessions = loadJson(path.join(DATA_DIR, 'sessions.json'), {});
  registeredGroups = loadJson(path.join(DATA_DIR, 'registered_groups.json'), {});
  logger.info({ groupCount: Object.keys(registeredGroups).length }, 'State loaded');
}

function saveState(): void {
  saveJson(path.join(DATA_DIR, 'router_state.json'), { last_agent_timestamp: lastAgentTimestamp });
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
}

function registerGroup(chatId: string, group: RegisteredGroup): void {
  registeredGroups[chatId] = group;
  saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);

  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info({ chatId, name: group.name, folder: group.folder }, 'Group registered');
}

function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredIds = new Set(Object.keys(registeredGroups));

  return chats
    .filter(c => c.jid !== '__group_sync__')
    .map(c => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredIds.has(c.jid)
    }));
}

async function processMessage(msg: NewMessage): Promise<void> {
  const group = registeredGroups[msg.chat_jid];
  if (!group) return;

  const content = msg.content.trim();
  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  // Main group responds to all messages; other groups require trigger prefix
  if (!isMainGroup && !TRIGGER_PATTERN.test(content)) return;

  // Prevent concurrent agent runs for the same chat
  if (activeAgentChats.has(msg.chat_jid)) {
    logger.debug({ chatJid: msg.chat_jid }, 'Agent already running for this chat, skipping');
    return;
  }

  // Get all messages since last agent interaction so the session has full context
  const sinceTimestamp = lastAgentTimestamp[msg.chat_jid] || '';
  const missedMessages = getMessagesSince(msg.chat_jid, sinceTimestamp, ASSISTANT_NAME);

  const lines = missedMessages.map(m => {
    const escapeXml = (s: string) => s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`;
  });
  const prompt = `<messages>\n${lines.join('\n')}\n</messages>`;

  if (!prompt) return;

  logger.info({ group: group.name, messageCount: missedMessages.length }, 'Processing message');

  activeAgentChats.add(msg.chat_jid);
  try {
    await setTyping(msg.chat_jid);
    const { response, sentViaIpc } = await runAgent(group, prompt, msg.chat_jid);

    if (response && !sentViaIpc) {
      lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
      await sendMessage(msg.chat_jid, `${ASSISTANT_NAME}: ${response}`);
    } else if (response) {
      lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
    }
  } finally {
    activeAgentChats.delete(msg.chat_jid);
  }
}

interface AgentResult {
  response: string | null;
  sentViaIpc: boolean;
}

async function runAgent(group: RegisteredGroup, prompt: string, chatJid: string): Promise<AgentResult> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  const tasks = getAllTasks();
  writeTasksSnapshot(group.folder, isMain, tasks.map(t => ({
    id: t.id,
    groupFolder: t.group_folder,
    prompt: t.prompt,
    schedule_type: t.schedule_type,
    schedule_value: t.schedule_value,
    status: t.status,
    next_run: t.next_run
  })));

  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(group.folder, isMain, availableGroups, new Set(Object.keys(registeredGroups)));

  try {
    const output = await runContainerAgent(group, {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid,
      isMain
    });

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    }

    if (output.status === 'error') {
      logger.error({ group: group.name, error: output.error }, 'Container agent error');
      return { response: null, sentViaIpc: output.sentViaIpc || false };
    }

    return { response: output.result, sentViaIpc: output.sentViaIpc || false };
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return { response: null, sentViaIpc: false };
  }
}

async function sendMessage(chatId: string, text: string): Promise<void> {
  try {
    // Telegram has 4096 char limit per message
    const MAX_LEN = 4096;
    if (text.length <= MAX_LEN) {
      await bot.telegram.sendMessage(chatId, text);
    } else {
      // Split into chunks
      for (let i = 0; i < text.length; i += MAX_LEN) {
        await bot.telegram.sendMessage(chatId, text.slice(i, i + MAX_LEN));
      }
    }
    logger.info({ chatId, length: text.length }, 'Message sent');
  } catch (err) {
    logger.error({ chatId, err }, 'Failed to send message');
  }
}

async function sendPhoto(chatId: string, photoPath: string, caption?: string): Promise<void> {
  try {
    if (!fs.existsSync(photoPath)) {
      logger.error({ chatId, photoPath }, 'Photo file not found');
      return;
    }
    await bot.telegram.sendPhoto(chatId, { source: fs.createReadStream(photoPath) }, {
      caption: caption ? `${ASSISTANT_NAME}: ${caption}` : undefined
    });
    logger.info({ chatId, photoPath }, 'Photo sent');
  } catch (err) {
    logger.error({ chatId, photoPath, err }, 'Failed to send photo');
  }
}

async function sendDocument(chatId: string, documentPath: string, caption?: string, filename?: string): Promise<void> {
  try {
    if (!fs.existsSync(documentPath)) {
      logger.error({ chatId, documentPath }, 'Document file not found');
      return;
    }
    await bot.telegram.sendDocument(chatId, { source: fs.createReadStream(documentPath), filename }, {
      caption: caption ? `${ASSISTANT_NAME}: ${caption}` : undefined
    });
    logger.info({ chatId, documentPath }, 'Document sent');
  } catch (err) {
    logger.error({ chatId, documentPath, err }, 'Failed to send document');
  }
}

async function sendVideo(chatId: string, videoPath: string, caption?: string): Promise<void> {
  try {
    if (!fs.existsSync(videoPath)) {
      logger.error({ chatId, videoPath }, 'Video file not found');
      return;
    }
    await bot.telegram.sendVideo(chatId, { source: fs.createReadStream(videoPath) }, {
      caption: caption ? `${ASSISTANT_NAME}: ${caption}` : undefined
    });
    logger.info({ chatId, videoPath }, 'Video sent');
  } catch (err) {
    logger.error({ chatId, videoPath, err }, 'Failed to send video');
  }
}

async function sendAudio(chatId: string, audioPath: string, caption?: string): Promise<void> {
  try {
    if (!fs.existsSync(audioPath)) {
      logger.error({ chatId, audioPath }, 'Audio file not found');
      return;
    }
    await bot.telegram.sendAudio(chatId, { source: fs.createReadStream(audioPath) }, {
      caption: caption ? `${ASSISTANT_NAME}: ${caption}` : undefined
    });
    logger.info({ chatId, audioPath }, 'Audio sent');
  } catch (err) {
    logger.error({ chatId, audioPath, err }, 'Failed to send audio');
  }
}

async function sendVoice(chatId: string, voicePath: string, caption?: string): Promise<void> {
  try {
    if (!fs.existsSync(voicePath)) {
      logger.error({ chatId, voicePath }, 'Voice file not found');
      return;
    }
    await bot.telegram.sendVoice(chatId, { source: fs.createReadStream(voicePath) }, {
      caption: caption ? `${ASSISTANT_NAME}: ${caption}` : undefined
    });
    logger.info({ chatId, voicePath }, 'Voice sent');
  } catch (err) {
    logger.error({ chatId, voicePath, err }, 'Failed to send voice');
  }
}

async function sendFeishu(text: string, title?: string): Promise<void> {
  const webhookUrl = process.env.FEISHU_WEBHOOK_URL;
  const secret = process.env.FEISHU_SECRET;
  if (!webhookUrl) {
    logger.warn('FEISHU_WEBHOOK_URL not configured, skipping');
    return;
  }
  try {
    let body: object;
    if (title) {
      body = {
        msg_type: 'post',
        content: {
          post: {
            zh_cn: {
              title,
              content: [[{ tag: 'text', text }]]
            }
          }
        }
      };
    } else {
      body = { msg_type: 'text', content: { text } };
    }

    // Sign if secret configured
    if (secret) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const crypto = await import('crypto');
      const stringToSign = `${timestamp}\n${secret}`;
      const hmac = crypto.createHmac('sha256', stringToSign).update('').digest('base64');
      Object.assign(body, { timestamp, sign: hmac });
    }

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await res.json();
    logger.info({ result }, 'Feishu message sent');
  } catch (err) {
    logger.error({ err }, 'Failed to send Feishu message');
  }
}

function startIpcWatcher(): void {
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter(f => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs.readdirSync(messagesDir).filter(f => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              const targetGroup = registeredGroups[data.chatJid];
              const authorized = isMain || (targetGroup && targetGroup.folder === sourceGroup);

              if (data.type === 'message' && data.chatJid && data.text) {
                if (authorized) {
                  await sendMessage(data.chatJid, `${ASSISTANT_NAME}: ${data.text}`);
                  logger.info({ chatJid: data.chatJid, sourceGroup }, 'IPC message sent');
                } else {
                  logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized IPC message attempt blocked');
                }
              } else if (data.type === 'photo' && data.chatJid && data.photoPath) {
                if (authorized) {
                  // Map container paths to host paths
                  let hostPhotoPath = data.photoPath;
                  if (hostPhotoPath.startsWith('/workspace/group/')) {
                    hostPhotoPath = path.join(GROUPS_DIR, sourceGroup, hostPhotoPath.replace('/workspace/group/', ''));
                  } else if (hostPhotoPath.startsWith('/workspace/project/')) {
                    hostPhotoPath = path.join(process.cwd(), hostPhotoPath.replace('/workspace/project/', ''));
                  }
                  await sendPhoto(data.chatJid, hostPhotoPath, data.caption);
                  logger.info({ chatJid: data.chatJid, sourceGroup, containerPath: data.photoPath, hostPath: hostPhotoPath }, 'IPC photo sent');
                } else {
                  logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized IPC photo attempt blocked');
                }
              } else if (data.type === 'document' && data.chatJid && data.documentPath) {
                if (authorized) {
                  let hostDocumentPath = data.documentPath;
                  if (hostDocumentPath.startsWith('/workspace/group/')) {
                    hostDocumentPath = path.join(GROUPS_DIR, sourceGroup, hostDocumentPath.replace('/workspace/group/', ''));
                  } else if (hostDocumentPath.startsWith('/workspace/project/')) {
                    hostDocumentPath = path.join(process.cwd(), hostDocumentPath.replace('/workspace/project/', ''));
                  }
                  await sendDocument(data.chatJid, hostDocumentPath, data.caption, data.filename);
                  logger.info({ chatJid: data.chatJid, sourceGroup, containerPath: data.documentPath, hostPath: hostDocumentPath }, 'IPC document sent');
                } else {
                  logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized IPC document attempt blocked');
                }
              } else if (data.type === 'video' && data.chatJid && data.videoPath) {
                if (authorized) {
                  let hostVideoPath = data.videoPath;
                  if (hostVideoPath.startsWith('/workspace/group/')) {
                    hostVideoPath = path.join(GROUPS_DIR, sourceGroup, hostVideoPath.replace('/workspace/group/', ''));
                  } else if (hostVideoPath.startsWith('/workspace/project/')) {
                    hostVideoPath = path.join(process.cwd(), hostVideoPath.replace('/workspace/project/', ''));
                  }
                  await sendVideo(data.chatJid, hostVideoPath, data.caption);
                  logger.info({ chatJid: data.chatJid, sourceGroup, containerPath: data.videoPath, hostPath: hostVideoPath }, 'IPC video sent');
                } else {
                  logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized IPC video attempt blocked');
                }
              } else if (data.type === 'audio' && data.chatJid && data.audioPath) {
                if (authorized) {
                  let hostAudioPath = data.audioPath;
                  if (hostAudioPath.startsWith('/workspace/group/')) {
                    hostAudioPath = path.join(GROUPS_DIR, sourceGroup, hostAudioPath.replace('/workspace/group/', ''));
                  } else if (hostAudioPath.startsWith('/workspace/project/')) {
                    hostAudioPath = path.join(process.cwd(), hostAudioPath.replace('/workspace/project/', ''));
                  }
                  await sendAudio(data.chatJid, hostAudioPath, data.caption);
                  logger.info({ chatJid: data.chatJid, sourceGroup, containerPath: data.audioPath, hostPath: hostAudioPath }, 'IPC audio sent');
                } else {
                  logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized IPC audio attempt blocked');
                }
              } else if (data.type === 'voice' && data.chatJid && data.voicePath) {
                if (authorized) {
                  let hostVoicePath = data.voicePath;
                  if (hostVoicePath.startsWith('/workspace/group/')) {
                    hostVoicePath = path.join(GROUPS_DIR, sourceGroup, hostVoicePath.replace('/workspace/group/', ''));
                  } else if (hostVoicePath.startsWith('/workspace/project/')) {
                    hostVoicePath = path.join(process.cwd(), hostVoicePath.replace('/workspace/project/', ''));
                  }
                  await sendVoice(data.chatJid, hostVoicePath, data.caption);
                  logger.info({ chatJid: data.chatJid, sourceGroup, containerPath: data.voicePath, hostPath: hostVoicePath }, 'IPC voice sent');
                } else {
                  logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized IPC voice attempt blocked');
                }
              } else if (data.type === 'feishu' && data.text) {
                await sendFeishu(data.text, data.title);
                logger.info({ sourceGroup }, 'IPC feishu message sent');
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error({ file, sourceGroup, err }, 'Error processing IPC message');
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC messages directory');
      }

      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              await processTaskIpc(data, sourceGroup, isMain);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error({ file, sourceGroup, err }, 'Error processing IPC task');
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string,
  isMain: boolean
): Promise<void> {
  const { createTask, updateTask, deleteTask, getTaskById: getTask } = await import('./db.js');
  const { CronExpressionParser } = await import('cron-parser');

  switch (data.type) {
    case 'schedule_task':
      if (data.prompt && data.schedule_type && data.schedule_value && data.groupFolder) {
        const targetGroup = data.groupFolder;
        if (!isMain && targetGroup !== sourceGroup) {
          logger.warn({ sourceGroup, targetGroup }, 'Unauthorized schedule_task attempt blocked');
          break;
        }

        const targetId = Object.entries(registeredGroups).find(
          ([, group]) => group.folder === targetGroup
        )?.[0];

        if (!targetId) {
          logger.warn({ targetGroup }, 'Cannot schedule task: target group not registered');
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, { tz: TIMEZONE });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid cron expression');
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid interval');
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid timestamp');
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode = (data.context_mode === 'group' || data.context_mode === 'isolated')
          ? data.context_mode
          : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetGroup,
          chat_jid: targetId,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString()
        });
        logger.info({ taskId, sourceGroup, targetGroup, contextMode }, 'Task created via IPC');
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task paused via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task pause attempt');
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task resumed via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task resume attempt');
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task cancelled via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task cancel attempt');
        }
      }
      break;

    case 'register_group':
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized register_group attempt blocked');
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig
        });
      } else {
        logger.warn({ data }, 'Invalid register_group request - missing required fields');
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

function ensureDockerRunning(): void {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    logger.debug('Docker daemon is running');
  } catch {
    logger.error('Docker daemon is not running');
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Docker is not running                                  ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without Docker. To fix:                     ║');
    console.error('║  Linux: sudo systemctl start docker                            ║');
    console.error('║                                                                ║');
    console.error('║  Install from: https://docker.com/products/docker-desktop      ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Docker is required but not running');
  }
}

function startTelegramBot(): void {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is required. Set it in .env');
  }

  bot = new Telegraf(TELEGRAM_BOT_TOKEN);

  // Handle text messages
  bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const timestamp = new Date(ctx.message.date * 1000).toISOString();
    const sender = ctx.from.id.toString();
    const senderName = ctx.from.first_name || ctx.from.username || sender;
    const content = ctx.message.text;
    const msgId = ctx.message.message_id.toString();
    const isFromMe = false; // Bot messages come through a different path

    logger.info({ chatId, senderName, content: content.substring(0, 50) }, 'Incoming message');

    // Store chat metadata for discovery
    const chatName = ctx.chat.type === 'private'
      ? (senderName)
      : ('title' in ctx.chat ? ctx.chat.title || chatId : chatId);
    storeChatMetadata(chatId, timestamp, chatName);

    // Only store full message content for registered groups
    if (registeredGroups[chatId]) {
      storeMessage({
        id: msgId,
        chatJid: chatId,
        sender,
        senderName,
        content,
        timestamp,
        isFromMe
      });

      // Process immediately (push model, no polling needed)
      const msg: NewMessage = {
        id: msgId,
        chat_jid: chatId,
        sender,
        sender_name: senderName,
        content,
        timestamp
      };

      // Fire-and-forget: don't await, as agent execution can take minutes
      processMessage(msg).then(() => saveState()).catch(err => {
        logger.error({ err, msgId }, 'Error processing message');
      });
    }
  });

  // Graceful shutdown
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  bot.launch();
  logger.info(`NanoClaw running on Telegram (trigger: @${ASSISTANT_NAME})`);

  // Start scheduler and IPC watcher
  startSchedulerLoop({
    sendMessage,
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions
  });
  startIpcWatcher();
}

async function main(): Promise<void> {
  ensureDockerRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  startTelegramBot();
}

main().catch(err => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});

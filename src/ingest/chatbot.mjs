import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ROOT,
  safeDataPath,
} from '../../daemon/run.mjs';
import {
  createSubstrateStore,
  optionalString,
  requiredString,
} from '../substrate.mjs';
import {
  ingestWire,
  walkIngestDir,
} from './wire.mjs';

const HUMAN_SIGNAL_WEIGHT = 2;
const ASSISTANT_SIGNAL_WEIGHT = 1;
const CHATBOT_DATA_DIR = path.join(ROOT, 'data');

export const CHATBOT_INGEST_DIR = fileURLToPath(
  new URL('../../data/ingest/', import.meta.url),
);

export const CLAUDE_EXPORT_CANDIDATES = Object.freeze([
  path.join(CHATBOT_INGEST_DIR, 'claude', 'conversations.json'),
  path.join(CHATBOT_INGEST_DIR, 'claude.ai', 'conversations.json'),
  path.join(CHATBOT_INGEST_DIR, 'claude-ai', 'conversations.json'),
  path.join(CHATBOT_INGEST_DIR, 'claude-conversations.json'),
  path.join(CHATBOT_INGEST_DIR, 'claude_conversations.json'),
  path.join(CHATBOT_INGEST_DIR, 'conversations-claude.json'),
]);

export const CHATGPT_EXPORT_CANDIDATES = Object.freeze([
  path.join(CHATBOT_INGEST_DIR, 'chatgpt', 'conversations.json'),
  path.join(CHATBOT_INGEST_DIR, 'openai', 'conversations.json'),
  path.join(CHATBOT_INGEST_DIR, 'chatgpt-conversations.json'),
  path.join(CHATBOT_INGEST_DIR, 'chatgpt_conversations.json'),
  path.join(CHATBOT_INGEST_DIR, 'conversations-chatgpt.json'),
]);

export async function ingestChatbot(options = {}) {
  const store = options.store ?? createSubstrateStore(options.storeOptions);
  const [claudeFile, chatgptFile] = await Promise.all([
    exportPath(options.claudePath, CLAUDE_EXPORT_CANDIDATES, [
      'claude',
      'claude.ai',
      'claude-ai',
    ]),
    exportPath(options.chatgptPath, CHATGPT_EXPORT_CANDIDATES, [
      'chatgpt',
      'chat-gpt',
      'openai',
    ]),
  ]);

  const batches = [];
  const skipped = {};

  const claudePayload = await loadJsonIfPresent(claudeFile);
  if (claudePayload) {
    batches.push({
      surface: 'claude',
      file: claudePayload.file,
      records: claudeAiAdapter(claudePayload.payload),
    });
  } else {
    skipped.claude = true;
  }

  const chatgptPayload = await loadJsonIfPresent(chatgptFile);
  if (chatgptPayload) {
    batches.push({
      surface: 'chatgpt',
      file: chatgptPayload.file,
      records: chatgptAdapter(chatgptPayload.payload),
    });
  } else {
    skipped.chatgpt = true;
  }

  const results = [];
  for (const batch of batches) {
    const result = await ingestWire(batch.records, batch.surface, { store });
    results.push({ ...result, file: batch.file });
  }

  return {
    store,
    results,
    skipped,
    exposures: results.flatMap((result) => result.exposures),
    createdCount: sum(results, 'createdCount'),
    duplicateCount: sum(results, 'duplicateCount'),
  };
}

export function claudeAiAdapter(payload) {
  return adaptConversations(payload, 'claude', (conversation, conversationIndex) => {
    if (!conversation || typeof conversation !== 'object') return [];

    const messages = Array.isArray(conversation.chat_messages)
      ? conversation.chat_messages
      : [];
    if (messages.length === 0) return [];

    const conversationId = conversationIdFor(
      conversation,
      conversationIndex,
      'claude',
    );
    const conversationName = optionalString(conversation.name);

    return messages.flatMap((message, messageIndex) => {
      if (!message || typeof message !== 'object') return [];

      const sender = optionalString(message.sender);
      if (sender !== 'human' && sender !== 'assistant') return [];

      const statement = optionalString(message.text);
      const eventAt = timestampToIso(message.created_at);
      if (!statement || !eventAt) return [];

      return [
        chatbotExposureRecord({
          surface: 'claude',
          conversationId,
          conversationName,
          messageId: optionalString(message.uuid ?? message.id) ?? `turn-${messageIndex}`,
          turnIndex: messageIndex,
          role: sender,
          originalRole: sender,
          statement,
          eventAt,
        }),
      ];
    });
  });
}

export function chatgptAdapter(payload) {
  return adaptConversations(payload, 'chatgpt', (conversation, conversationIndex) => {
    if (!conversation || typeof conversation !== 'object') return [];
    if (!conversation.mapping || typeof conversation.mapping !== 'object') return [];

    const conversationId = conversationIdFor(
      conversation,
      conversationIndex,
      'chatgpt',
    );
    const conversationName = optionalString(conversation.title ?? conversation.name);
    let turnIndex = 0;

    return chatGptNodeOrder(conversation.mapping).flatMap((nodeId) => {
      const node = conversation.mapping[nodeId];
      const message = node?.message;
      if (!message || typeof message !== 'object') return [];

      const role = optionalString(message.author?.role);
      if (role !== 'user' && role !== 'assistant') return [];

      const statement = chatGptMessageText(message.content);
      const eventAt = timestampToIso(message.create_time ?? node.create_time);
      if (!statement || !eventAt) return [];

      const normalizedRole = role === 'user' ? 'human' : 'assistant';
      const record = chatbotExposureRecord({
        surface: 'chatgpt',
        conversationId,
        conversationName,
        messageId: nodeId,
        turnIndex,
        role: normalizedRole,
        originalRole: role,
        statement,
        eventAt,
      });
      turnIndex += 1;
      return [record];
    });
  });
}

function adaptConversations(payload, surface, adapter) {
  const records = [];
  const conversations = conversationsFromPayload(payload);

  for (let conversationIndex = 0; conversationIndex < conversations.length; conversationIndex += 1) {
    const conversation = conversations[conversationIndex];
    try {
      records.push(...adapter(conversation, conversationIndex));
    } catch (error) {
      logSkippedConversation(surface, conversation, conversationIndex, error);
    }
  }

  return records;
}

function logSkippedConversation(surface, conversation, conversationIndex, error) {
  console.warn(
    `skipped ${surface} conversation ${safeConversationLabel(
      surface,
      conversation,
      conversationIndex,
    )}: ${errorMessage(error)}`,
  );
}

function chatbotExposureRecord({
  surface,
  conversationId,
  conversationName,
  messageId,
  turnIndex,
  role,
  originalRole,
  statement,
  eventAt,
}) {
  const normalizedSurface = requiredString(surface, 'surface');
  const normalizedConversationId = requiredString(conversationId, 'conversationId');
  const normalizedMessageId = requiredString(messageId, 'messageId');
  const normalizedRole = requiredString(role, 'role');
  const human = normalizedRole === 'human';
  const signalWeight = human ? HUMAN_SIGNAL_WEIGHT : ASSISTANT_SIGNAL_WEIGHT;

  const metadata = {
    conversationId: normalizedConversationId,
    turnIndex,
    role: normalizedRole,
    originalRole: optionalString(originalRole) ?? normalizedRole,
    human,
    signalWeight,
    messageId: normalizedMessageId,
  };
  const normalizedConversationName = optionalString(conversationName);
  if (normalizedConversationName) metadata.conversationName = normalizedConversationName;

  return {
    type: 'observation',
    statement: requiredString(statement, 'statement'),
    sourceId: [
      normalizedSurface,
      normalizedConversationId,
      normalizedMessageId,
    ].join(':'),
    eventAt: requiredString(eventAt, 'eventAt'),
    context: normalizedConversationName ?? normalizedConversationId,
    provenance: { surface: normalizedSurface, lane: 'deliberate' },
    conversationId: normalizedConversationId,
    human,
    signalWeight,
    metadata,
  };
}

function conversationsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.conversations)) return payload.conversations;
  return [];
}

function conversationIdFor(conversation, index, surface) {
  return (
    optionalString(
      conversation.uuid ??
        conversation.id ??
        conversation.conversation_id ??
        conversation.conversationId,
    ) ?? `${surface}-conversation-${index}`
  );
}

function safeConversationLabel(surface, conversation, index) {
  try {
    return conversationIdFor(conversation, index, surface);
  } catch {
    return `${surface}-conversation-${index}`;
  }
}

function errorMessage(error) {
  return optionalString(error?.message) ?? String(error);
}

function chatGptNodeOrder(mapping) {
  const entries = Object.entries(mapping).filter(([, node]) =>
    node && typeof node === 'object',
  );
  const childMap = new Map();

  for (const [nodeId, node] of entries) {
    const parentId = optionalString(node.parent);
    if (!parentId) continue;
    const siblings = childMap.get(parentId) ?? [];
    siblings.push(nodeId);
    childMap.set(parentId, siblings);
  }

  const roots = entries
    .filter(([, node]) => {
      const parentId = optionalString(node.parent);
      return !parentId || !mapping[parentId];
    })
    .map(([nodeId]) => nodeId);
  const startIds = roots.length > 0 ? roots : entries.map(([nodeId]) => nodeId);
  const ordered = [];
  const visited = new Set();

  function visit(nodeId) {
    const stack = [nodeId];
    while (stack.length > 0) {
      const currentId = stack.pop();
      if (visited.has(currentId)) continue;
      const node = mapping[currentId];
      if (!node || typeof node !== 'object') continue;

      visited.add(currentId);
      ordered.push(currentId);

      const children = childrenForNode(currentId, node, childMap)
        .filter((childId) => mapping[childId]);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        if (!visited.has(children[index])) stack.push(children[index]);
      }
    }
  }

  for (const nodeId of startIds) visit(nodeId);
  for (const [nodeId] of entries) visit(nodeId);

  return ordered;
}

function childrenForNode(nodeId, node, childMap) {
  const explicitChildren = Array.isArray(node.children)
    ? node.children.map(optionalString).filter(Boolean)
    : [];
  return explicitChildren.length > 0 ? explicitChildren : childMap.get(nodeId) ?? [];
}

function chatGptMessageText(content) {
  if (!content || typeof content !== 'object') return undefined;
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const text = parts.map(contentPartText).filter(Boolean).join('\n\n');
  return optionalString(text);
}

function contentPartText(part) {
  if (typeof part === 'string') return optionalString(part);
  if (typeof part === 'number' || typeof part === 'boolean') {
    return optionalString(part);
  }
  if (part && typeof part === 'object') {
    return optionalString(part.text ?? part.content);
  }
  return undefined;
}

function timestampToIso(value) {
  if (value === undefined || value === null) return undefined;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return dateToIso(new Date(toMillis(value)));
  }

  const timestamp = optionalString(value);
  if (!timestamp) return undefined;

  if (/^-?\d+(?:\.\d+)?$/.test(timestamp)) {
    const numeric = Number(timestamp);
    if (!Number.isFinite(numeric)) return undefined;
    return dateToIso(new Date(toMillis(numeric)));
  }

  const withZone = /(?:z|[+-]\d\d:\d\d)$/i.test(timestamp)
    ? timestamp
    : `${timestamp}Z`;
  return dateToIso(new Date(withZone));
}

function toMillis(numericTimestamp) {
  return Math.abs(numericTimestamp) < 100000000000
    ? numericTimestamp * 1000
    : numericTimestamp;
}

function dateToIso(date) {
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

async function exportPath(explicitPath, candidates, pathHints) {
  const normalized = optionalString(explicitPath);
  if (normalized) return chatbotExportPath(normalized);

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return chatbotExportPath(candidate);
  }
  const discovered = await discoverConversationsExport(pathHints);
  return discovered ? chatbotExportPath(discovered) : undefined;
}

function chatbotExportPath(file) {
  const resolved = path.resolve(requiredString(file, 'chatbot export path'));
  return safeDataPath(CHATBOT_DATA_DIR, path.relative(CHATBOT_DATA_DIR, resolved) || '.');
}

async function loadJsonIfPresent(file) {
  const normalizedFile = optionalString(file);
  if (!normalizedFile) return null;

  try {
    return {
      file: normalizedFile,
      payload: JSON.parse(await fs.readFile(normalizedFile, 'utf8')),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function discoverConversationsExport(pathHints) {
  const files = await walkIngestDir(
    CHATBOT_INGEST_DIR,
    (_file, entry) => entry.name === 'conversations.json',
  );
  return files
    .sort((a, b) => a.localeCompare(b))
    .find((file) => pathHints.some((hint) => fileIncludesHint(file, hint)));
}

function fileIncludesHint(file, hint) {
  return path
    .relative(CHATBOT_INGEST_DIR, file)
    .toLowerCase()
    .split(path.sep)
    .some((part) => part.includes(hint));
}

function sum(results, key) {
  return results.reduce((total, result) => total + result[key], 0);
}

import { isPlainObject, optionalString, stripUndefined } from '../substrate.mjs';
import {
  applyPacketPatch,
  buildPacketPatch,
  buildViewPacket,
  frontierExcludedForProvenance,
  validateViewPacket,
} from './view-packet.mjs';

const SENSITIVE_TURN_CLASSES = new Set(['personal', 'sensitive']);
const CITATION_KEYS = Object.freeze(['citations', 'sources']);
const MEMORY_SEARCH_TOOL_ID = 'memory.search';
const URL_KEYS = Object.freeze(['url', 'href', 'uri', 'link', 'sourceUrl']);
const TITLE_KEYS = Object.freeze(['title', 'name', 'label']);
const SNIPPET_KEYS = Object.freeze(['snippet', 'excerpt', 'description']);
const SOURCE_ID_KEYS = Object.freeze(['sourceId', 'source_id', 'id', 'ref']);
const HTTP_URL_PATTERN = 'https?:\\/\\/[^\\s<>"\'`)\\]]+';

export function viewTypeForContent(_result = {}) {
  return 'generic.text';
}

export function buildAnswerPacket(result = {}, options = {}) {
  const turn = normalizeTurnResult(result);
  const sensitivity = optionalString(options.sensitivity) ?? optionalString(turn.sensitivity);
  const provenance = turnProvenance(turn, { ...options, sensitivity });
  const rootFrontierExcluded = frontierExcludedForProvenance({
    provenance,
    frontierExcluded:
      turn.frontierExcluded === true ||
      turnRequiresFrontierExclusion(turn, { sensitivity }),
  });
  const citations = citationsForResult(turn);
  const children = childPacketsForResult(turn, {
    citations,
    rootFrontierExcluded,
    rootProvenance: provenance,
  });

  return validateViewPacket(buildViewPacket({
    viewType: viewTypeForContent(turn),
    text: contentForResult(turn),
    fields: answerFields(turn, { sensitivity, citations }),
    children: children.length > 0 ? children : undefined,
    provenance,
    frontierExcluded: rootFrontierExcluded,
  }));
}

export function createAnswerPatchEmitter(seed = {}, options = {}) {
  let packet = buildAnswerPacket({
    ...normalizeTurnResult(seed),
    content: undefined,
    status: optionalString(seed.status) ?? 'streaming',
  }, options);
  let content = '';
  const logger = options.logger;

  return Object.freeze({
    get packet() {
      return packet;
    },
    pushToken(delta) {
      const text = typeof delta === 'string' ? delta : '';
      if (!text) return undefined;
      content += text;
      return applyStreamPatch([{ op: 'set', field: 'text', value: content }]);
    },
    appendChild(child) {
      return applyStreamPatch([{ op: 'append_child', child }]);
    },
    flipStatus(status, extra = {}) {
      return applyStreamPatch([{
        op: 'flip',
        field: 'status',
        ...(extra.from !== undefined ? { from: extra.from } : {}),
        value: status,
      }]);
    },
  });

  function applyStreamPatch(ops) {
    const patch = buildPacketPatch({
      targetId: packet.id,
      ops,
    });
    const next = applyPacketPatch(packet, patch, { logger });
    if (next === packet) return undefined;
    packet = next;
    return buildPacketPatch({
      ...patch,
      resultId: packet.id,
    });
  }
}

function normalizeTurnResult(result) {
  if (typeof result === 'string') return { content: result };
  return isPlainObject(result) ? result : {};
}

function contentForResult(result) {
  return firstText(result.content, result.answer, result.text, result.message);
}

function answerFields(result, { sensitivity, citations }) {
  return stripUndefined({
    status: optionalString(result.status),
    lane: optionalString(result.lane),
    sensitivity,
    sovereign: typeof result.sovereign === 'boolean' ? result.sovereign : undefined,
    steps: finiteNumber(result.steps),
    held: Array.isArray(result.held) ? result.held.length : undefined,
    citation_count: citations.length > 0 ? citations.length : undefined,
  });
}

function turnProvenance(result, options = {}) {
  const supplied = isPlainObject(result.provenance) ? result.provenance : {};
  const labels = Array.isArray(result.provenance) ? result.provenance : [];
  const lane = optionalString(supplied.lane) ?? optionalString(result.lane);
  const surface =
    optionalString(options.surface) ??
    optionalString(supplied.surface) ??
    surfaceFromProvenanceLabels(labels) ??
    surfaceForTurn(result, options.sensitivity);

  return stripUndefined({
    ...supplied,
    surface,
    ...(lane ? { lane } : {}),
    plane: optionalString(supplied.plane) ?? optionalString(options.plane) ?? 'agent',
    module: optionalString(supplied.module) ?? optionalString(options.module) ?? 'packet-emit',
  });
}

function surfaceForTurn(result, sensitivity) {
  if (sensitivity === 'sensitive') return 'verbatim-chat';
  if (sensitivity === 'personal') return 'personal';
  if (sensitivity === 'internal') return 'internal';
  if (result.sovereign === true) return 'verbatim-chat';
  return 'public';
}

function turnRequiresFrontierExclusion(result, { sensitivity }) {
  return (
    result.sovereign === true ||
    SENSITIVE_TURN_CLASSES.has(sensitivity) ||
    provenanceLabelsRequireFrontierExclusion(result.provenance) ||
    toolResultsRequireFrontierExclusion(result.toolResults)
  );
}

function provenanceLabelsRequireFrontierExclusion(provenance) {
  if (!Array.isArray(provenance)) return false;
  return provenance.some((label) => {
    const surface = optionalString(label);
    return surface
      ? frontierExcludedForProvenance({ provenance: { surface } })
      : false;
  });
}

function childPacketsForResult(result, { citations, rootFrontierExcluded, rootProvenance }) {
  const children = [];
  children.push(...citations.map((citation, index) => citationPacketInput(citation, {
    index,
    rootFrontierExcluded,
    rootProvenance,
  })));
  children.push(...memorySearchPacketInputs(result, {
    rootProvenance,
  }));
  return children;
}

function toolResultsRequireFrontierExclusion(toolResults) {
  return toolResultsForResult({ toolResults }).some((result) =>
    result?.sensitive === true ||
    result?.frontierExcluded === true ||
    optionalString(result?.sensitivity) === 'sensitive' ||
    provenanceLabelsRequireFrontierExclusion(result?.provenance));
}

function memorySearchPacketInputs(result, { rootProvenance }) {
  return memorySearchArtifacts(result).map((artifact, index) =>
    memorySearchPacketInput(artifact, { index, rootProvenance }));
}

function memorySearchArtifacts(result) {
  const values = [];
  if (isPlainObject(result?.memorySearch)) values.push(result.memorySearch);

  for (const toolResult of toolResultsForResult(result)) {
    if (toolResult?.toolId !== MEMORY_SEARCH_TOOL_ID) continue;
    const artifacts = isPlainObject(toolResult.artifacts) ? toolResult.artifacts : {};
    if (isPlainObject(artifacts.memorySearch)) values.push(artifacts.memorySearch);
    if (isPlainObject(artifacts.memory_search)) values.push(artifacts.memory_search);
  }
  return values;
}

function toolResultsForResult(result) {
  if (!isPlainObject(result)) return [];
  const values = Array.isArray(result.toolResults)
    ? result.toolResults
    : Array.isArray(result.executed)
      ? result.executed
      : [];
  return values.filter(isPlainObject);
}

function memorySearchPacketInput(artifact, { index, rootProvenance }) {
  const exposures = memorySearchExposures(artifact.exposures);
  const mindOutputs = Array.isArray(artifact.mindOutputs) ? artifact.mindOutputs.filter(isPlainObject) : [];
  const evidenceIds = exposures
    .map((exposure) => optionalString(exposure.id))
    .filter(Boolean);
  const provenance = memorySearchProvenance(rootProvenance);
  const frontierExcluded = frontierExcludedForProvenance({
    provenance,
    frontierExcluded: true,
  });

  return {
    viewType: 'loop.evidence',
    text: memorySearchEvidenceText(artifact, exposures, index),
    fields: stripUndefined({
      toolId: MEMORY_SEARCH_TOOL_ID,
      query: optionalString(artifact.query),
      result_count: exposures.length,
      exposure_count: exposures.length,
      mind_output_count: mindOutputs.length > 0 ? mindOutputs.length : undefined,
      exposures,
      citations: exposureCitations(exposures),
    }),
    evidence: evidenceIds.length > 0 ? evidenceIds : undefined,
    children: mindOutputs.length > 0 ? mindOutputs : undefined,
    provenance,
    frontierExcluded,
  };
}

function memorySearchExposures(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => {
      if (!isPlainObject(entry)) return null;
      const id = optionalString(entry.id);
      const statement = optionalString(entry.statement);
      if (!id && !statement) return null;
      return stripUndefined({
        id,
        statement,
        surface: optionalString(entry.surface),
        eventAt: optionalString(entry.eventAt),
        score: finiteNumber(entry.score),
      });
    })
    .filter(Boolean);
}

function memorySearchEvidenceText(artifact, exposures, index) {
  const query = optionalString(artifact.query);
  if (query) return `Memory search: ${query}`;
  return `Memory search result ${index + 1}: ${exposures.length} exposure${exposures.length === 1 ? '' : 's'}`;
}

function exposureCitations(exposures) {
  return exposures
    .map((entry, index) => stripUndefined({
      sourceId: entry.id,
      citation: index + 1,
      surface: entry.surface,
      eventAt: entry.eventAt,
    }))
    .filter((entry) => Object.keys(entry).length > 0);
}

function memorySearchProvenance(rootProvenance) {
  return stripUndefined({
    surface: 'substrate',
    lane: optionalString(rootProvenance?.lane) ?? 'sovereign',
    plane: 'agent',
    module: 'packet-emit',
  });
}

function surfaceFromProvenanceLabels(labels) {
  const surfaces = labels.map((label) => optionalString(label)).filter(Boolean);
  return (
    surfaces.find((surface) =>
      frontierExcludedForProvenance({ provenance: { surface } })) ??
    surfaces[0]
  );
}

function citationsForResult(result) {
  const structured = [];
  for (const key of CITATION_KEYS) {
    structured.push(...citationValues(result[key]));
  }

  const values = structured.length > 0
    ? structured
    : citationsFromSourcesSection(contentForResult(result));

  return values
    .map((value, index) => normalizeCitation(value, index))
    .filter(Boolean);
}

function citationValues(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeCitation(value, index) {
  if (typeof value === 'string') {
    const url = urlFromText(value);
    const title = titleFromCitationText(value, url);
    if (!url && !title) return null;
    return stripUndefined({
      title,
      url,
      index: index + 1,
      text: optionalString(value),
    });
  }

  if (!isPlainObject(value)) return null;

  const url = firstUrlFromObject(value);
  const title = firstTextFromObject(value, TITLE_KEYS);
  const snippet = firstTextFromObject(value, SNIPPET_KEYS);
  const sourceId = firstTextFromObject(value, SOURCE_ID_KEYS);
  const text = firstText(value.text, value.content);

  if (!url && !title && !text) return null;

  return stripUndefined({
    title,
    url,
    snippet,
    sourceId,
    index: finiteNumber(value.index) ?? index + 1,
    provenance: isPlainObject(value.provenance) ? value.provenance : undefined,
    frontierExcluded: value.frontierExcluded === true ? true : undefined,
    text,
  });
}

function citationPacketInput(citation, { index, rootFrontierExcluded, rootProvenance }) {
  const provenance = citationProvenance(citation, rootProvenance);
  const frontierExcluded = frontierExcludedForProvenance({
    provenance,
    frontierExcluded: rootFrontierExcluded || citation.frontierExcluded === true,
  });

  return {
    viewType: 'preview.web',
    text: citation.title ?? citation.url ?? citation.text ?? `Source ${index + 1}`,
    fields: stripUndefined({
      title: citation.title,
      url: citation.url,
      snippet: citation.snippet,
      sourceId: citation.sourceId,
      citation: citation.index ?? index + 1,
    }),
    provenance,
    frontierExcluded,
  };
}

function citationProvenance(citation, rootProvenance) {
  const supplied = isPlainObject(citation.provenance) ? citation.provenance : {};
  return stripUndefined({
    ...supplied,
    surface: optionalString(supplied.surface) ?? 'web',
    lane: optionalString(supplied.lane) ?? optionalString(rootProvenance.lane),
    plane: optionalString(supplied.plane) ?? 'agent',
    module: optionalString(supplied.module) ?? 'packet-emit',
  });
}

function citationsFromSourcesSection(content) {
  const text = optionalString(content);
  if (!text) return [];

  const match = /\bSources?:\s*([\s\S]*)$/i.exec(text);
  if (!match) return [];

  const urls = [];
  for (const line of match[1].split(/\r?\n/)) {
    for (const url of urlsFromText(line)) {
      urls.push({
        url,
        title: titleFromCitationText(line, url),
        text: optionalString(line),
      });
    }
  }
  return urls;
}

function firstUrlFromObject(value) {
  for (const key of URL_KEYS) {
    const url = cleanUrl(value[key]);
    if (url) return url;
  }
  return urlFromText(firstText(value.text, value.content));
}

function urlsFromText(text) {
  const source = optionalString(text);
  if (!source) return [];
  return [...source.matchAll(new RegExp(HTTP_URL_PATTERN, 'gi'))]
    .map((match) => cleanUrl(match[0]))
    .filter(Boolean);
}

function urlFromText(text) {
  return urlsFromText(text)[0];
}

function cleanUrl(value) {
  const text = optionalString(value);
  if (!text) return undefined;
  const match = new RegExp(HTTP_URL_PATTERN, 'i').exec(text);
  return match ? match[0].replace(/[.,;]+$/u, '') : undefined;
}

function titleFromCitationText(value, url) {
  const text = optionalString(value);
  if (!text) return undefined;
  const cleaned = text
    .replace(url ?? '', '')
    .replace(/^\s*(?:[-*]\s*)?(?:\[\d+\]\s*)?/u, '')
    .replace(/\[[^\]]+\]\(\s*\)/u, '')
    .replace(/^[\s:-]+|[\s:-]+$/g, '');
  return optionalString(cleaned);
}

function firstTextFromObject(value, keys) {
  for (const key of keys) {
    const text = firstText(value[key]);
    if (text) return text;
  }
  return undefined;
}

function firstText(...values) {
  for (const value of values) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      const text = optionalString(value);
      if (text) return text;
    }
  }
  return undefined;
}

function finiteNumber(value) {
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

import { Readable } from 'node:stream';

/**
 * Translation layer between the OpenAI Chat Completions API and the OpenAI
 * Responses API (`/v1/responses`).
 *
 * SillyTavern speaks Chat Completions everywhere. Some providers (e.g. LinkAPI)
 * expose certain models *only* through the Responses API, which uses a different
 * request shape (`input` instead of `messages`) and a different reply shape
 * (`output[]` items / `response.*` SSE events instead of `choices[]`).
 *
 * These helpers convert in both directions so the rest of the app never has to
 * know the request was routed to `/responses`.
 */

/** Maps SillyTavern reasoning effort values to OpenAI Responses API values. */
const REASONING_EFFORT_MAP = {
    min: 'minimal',
    minimum: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    max: 'xhigh',
    maximum: 'xhigh',
};

/**
 * Convert Chat Completions message content into Responses API content parts.
 * @param {any} content Message content (string or array of parts).
 * @param {string} role Message role, used to pick input_* vs output_* part types.
 * @returns {any} Responses API content (string or array of parts).
 */
function convertContentParts(content, role) {
    if (typeof content === 'string') {
        return content;
    }

    if (!Array.isArray(content)) {
        return content ?? '';
    }

    const isAssistant = role === 'assistant';

    return content.map((part) => {
        if (!part || typeof part !== 'object') {
            return part;
        }
        switch (part.type) {
            case 'text':
                return { type: isAssistant ? 'output_text' : 'input_text', text: part.text ?? '' };
            case 'image_url':
                return { type: 'input_image', image_url: typeof part.image_url === 'string' ? part.image_url : part.image_url?.url };
            case 'input_audio':
                return { type: 'input_audio', input_audio: part.input_audio };
            default:
                return part;
        }
    });
}

/**
 * Translate a Chat Completions request body into an OpenAI Responses API request body.
 * @param {any} body Chat Completions request body (already assembled by the backend).
 * @returns {any} Responses API request body.
 */
export function convertChatToResponsesRequest(body) {
    const input = [];

    for (const message of (body.messages || [])) {
        const role = message?.role;

        // Tool result messages become function_call_output items.
        if (role === 'tool') {
            input.push({
                type: 'function_call_output',
                call_id: message.tool_call_id,
                output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
            });
            continue;
        }

        // Assistant tool calls become function_call items (after any text content).
        if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
            if (message.content) {
                input.push({ type: 'message', role, content: convertContentParts(message.content, role) });
            }
            for (const toolCall of message.tool_calls) {
                input.push({
                    type: 'function_call',
                    call_id: toolCall.id,
                    name: toolCall.function?.name,
                    arguments: toolCall.function?.arguments ?? '{}',
                });
            }
            continue;
        }

        input.push({ type: 'message', role, content: convertContentParts(message.content, role) });
    }

    /** @type {any} */
    const result = {
        model: body.model,
        input,
        stream: Boolean(body.stream),
    };

    // Sampling parameters (temperature, top_p, penalties, seed) are intentionally NOT
    // forwarded: the Responses API is used here for reasoning/"pro" models, which reject
    // them outright (e.g. gpt-5.5-pro returns "temperature is not supported with this model").
    const maxOutput = body.max_completion_tokens ?? body.max_tokens;
    if (typeof maxOutput === 'number') result.max_output_tokens = maxOutput;

    // Reasoning effort maps to reasoning.effort. ST uses auto/min/low/medium/high/max;
    // the Responses API expects minimal/low/medium/high/xhigh. 'auto' is omitted so the
    // server picks its own default (some models, e.g. gpt-5.5-pro, reject low/minimal).
    if (body.reasoning_effort && body.reasoning_effort !== 'auto') {
        const effort = REASONING_EFFORT_MAP[body.reasoning_effort] ?? body.reasoning_effort;
        result.reasoning = { effort };
    }

    // Verbosity maps to text.verbosity ('auto' is omitted to use the server default).
    if (body.verbosity && body.verbosity !== 'auto') {
        result.text = { ...(result.text || {}), verbosity: body.verbosity };
    }

    // Structured output maps to text.format.
    if (body.response_format?.type === 'json_schema' && body.response_format.json_schema) {
        result.text = {
            ...(result.text || {}),
            format: {
                type: 'json_schema',
                name: body.response_format.json_schema.name,
                strict: body.response_format.json_schema.strict,
                schema: body.response_format.json_schema.schema,
            },
        };
    }

    // Tools: flatten the Chat Completions { type, function: {...} } into Responses { type, ... }.
    if (Array.isArray(body.tools) && body.tools.length) {
        result.tools = body.tools.map((tool) => {
            if (tool.type === 'function' && tool.function) {
                return {
                    type: 'function',
                    name: tool.function.name,
                    description: tool.function.description,
                    parameters: tool.function.parameters,
                };
            }
            return tool;
        });
        if (body.tool_choice !== undefined) {
            result.tool_choice = body.tool_choice;
        }
    }

    return result;
}

/**
 * Extract assistant content, reasoning and tool calls from a Responses API output array.
 * @param {any[]} output Responses API `output` array.
 * @returns {{ content: string, reasoning: string, toolCalls: any[] }}
 */
function extractFromOutput(output) {
    let content = '';
    let reasoning = '';
    const toolCalls = [];

    for (const item of (output || [])) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        switch (item.type) {
            case 'message':
                for (const part of (item.content || [])) {
                    if (part?.type === 'output_text') content += part.text ?? '';
                    if (part?.type === 'refusal') content += part.refusal ?? '';
                }
                break;
            case 'reasoning':
                for (const summary of (item.summary || [])) {
                    reasoning += (typeof summary === 'string' ? summary : summary?.text) ?? '';
                }
                break;
            case 'function_call':
                toolCalls.push({
                    id: item.call_id || item.id,
                    type: 'function',
                    function: { name: item.name, arguments: item.arguments ?? '' },
                });
                break;
            default:
                break;
        }
    }

    return { content, reasoning, toolCalls };
}

/**
 * Convert Responses API usage to Chat Completions usage.
 * @param {any} usage Responses API usage object.
 * @returns {any} Chat Completions usage object (or undefined).
 */
function convertUsage(usage) {
    if (!usage) {
        return undefined;
    }
    return {
        prompt_tokens: usage.input_tokens ?? 0,
        completion_tokens: usage.output_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0,
        completion_tokens_details: usage.output_tokens_details
            ? { reasoning_tokens: usage.output_tokens_details.reasoning_tokens ?? 0 }
            : undefined,
    };
}

/**
 * Translate a non-streaming Responses API reply into a Chat Completion object.
 * @param {any} resp Responses API reply.
 * @returns {any} Chat Completion object.
 */
export function convertResponsesToChatCompletion(resp) {
    const { content, reasoning, toolCalls } = extractFromOutput(resp?.output);

    /** @type {any} */
    const message = { role: 'assistant', content };
    if (reasoning) message.reasoning_content = reasoning;
    if (toolCalls.length) message.tool_calls = toolCalls;

    const finishReason = toolCalls.length
        ? 'tool_calls'
        : (resp?.status === 'incomplete' ? 'length' : 'stop');

    return {
        id: resp?.id,
        object: 'chat.completion',
        created: resp?.created_at,
        model: resp?.model,
        choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
        usage: convertUsage(resp?.usage),
    };
}

/**
 * Pipe a streaming Responses API SSE response to an Express response, translating
 * each event into Chat Completions `chat.completion.chunk` SSE on the fly.
 * @param {import('node-fetch').Response} from Upstream fetch response (SSE).
 * @param {import('express').Response} to Express response to write to.
 * @param {string} model Model id to stamp on emitted chunks.
 * @returns {Promise<void>}
 */
export async function forwardResponsesStream(from, to, model) {
    let statusCode = from.status;
    if (statusCode === 401) {
        statusCode = 400;
    }
    to.statusCode = statusCode;
    to.statusMessage = from.statusText;

    if (!from.ok || !from.body) {
        try {
            const rawErrorText = from.body ? await from.text() : '';
            console.warn(`Responses streaming request failed with status ${from.status} ${from.statusText}: ${rawErrorText || 'Unknown error occurred'}`);
            to.end(rawErrorText || '', 'utf-8');
        } catch {
            to.end();
        }
        return;
    }

    to.setHeader('Content-Type', 'text/event-stream');
    to.setHeader('Cache-Control', 'no-cache');
    to.setHeader('Connection', 'keep-alive');

    const created = Math.floor(Date.now() / 1000);
    let responseId = 'chatcmpl-' + created;
    let usage;
    let finishReason = 'stop';
    /** @type {Map<number, number>} Maps Responses output_index -> Chat Completions tool_call index. */
    const toolIndexMap = new Map();
    let nextToolIndex = 0;

    /**
     * Write a single chat.completion.chunk to the client.
     * @param {any} delta Delta payload.
     * @param {string|null} reason finish_reason (or null).
     */
    const writeChunk = (delta, reason = null) => {
        if (to.writableEnded || !to.writable) {
            return;
        }
        /** @type {any} */
        const chunk = {
            id: responseId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta, finish_reason: reason }],
        };
        to.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    /**
     * Handle a single parsed Responses API event.
     * @param {any} event Parsed event object.
     */
    const handleEvent = (event) => {
        if (!event || typeof event !== 'object') {
            return;
        }
        switch (event.type) {
            case 'response.created':
            case 'response.in_progress':
                if (event.response?.id) responseId = event.response.id;
                break;
            case 'response.output_text.delta':
                if (event.delta) writeChunk({ content: event.delta });
                break;
            case 'response.refusal.delta':
                if (event.delta) writeChunk({ content: event.delta });
                break;
            case 'response.reasoning_text.delta':
            case 'response.reasoning_summary_text.delta':
                if (event.delta) writeChunk({ reasoning_content: event.delta });
                break;
            case 'response.output_item.added':
                if (event.item?.type === 'function_call') {
                    const toolIndex = nextToolIndex++;
                    toolIndexMap.set(event.output_index, toolIndex);
                    finishReason = 'tool_calls';
                    writeChunk({
                        tool_calls: [{
                            index: toolIndex,
                            id: event.item.call_id || event.item.id,
                            type: 'function',
                            function: { name: event.item.name ?? '', arguments: '' },
                        }],
                    });
                }
                break;
            case 'response.function_call_arguments.delta': {
                const toolIndex = toolIndexMap.get(event.output_index) ?? 0;
                if (event.delta) {
                    finishReason = 'tool_calls';
                    writeChunk({ tool_calls: [{ index: toolIndex, function: { arguments: event.delta } }] });
                }
                break;
            }
            case 'response.completed':
            case 'response.incomplete':
                usage = convertUsage(event.response?.usage);
                if (event.type === 'response.incomplete' && finishReason !== 'tool_calls') {
                    finishReason = 'length';
                }
                break;
            case 'response.failed':
            case 'error': {
                const message = event.response?.error?.message || event.message || 'Responses API stream error';
                console.warn('Responses API stream error:', message);
                writeChunk({}, 'stop');
                break;
            }
            default:
                break;
        }
    };

    const decoder = new TextDecoder();
    let buffer = '';

    /**
     * Parse and dispatch any complete SSE blocks accumulated in the buffer.
     */
    const drainBuffer = () => {
        let separatorIndex;
        while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
            const rawBlock = buffer.slice(0, separatorIndex);
            buffer = buffer.slice(separatorIndex + 2);

            const dataLines = rawBlock
                .split('\n')
                .filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).trim());

            if (dataLines.length === 0) {
                continue;
            }

            const payload = dataLines.join('\n');
            if (payload === '[DONE]') {
                continue;
            }

            try {
                handleEvent(JSON.parse(payload));
            } catch (error) {
                console.warn('Failed to parse Responses API SSE payload:', payload, error);
            }
        }
    };

    const body = /** @type {any} */ (from.body);

    // If the client disconnects (e.g. generation stopped or swiped away), tear down the
    // upstream stream. We deliberately do NOT call to.end() here: the for-await loop below
    // will exit and the terminating block ends the response once, guarded by writableEnded.
    to.socket?.on('close', function () {
        if (body instanceof Readable) body.destroy();
    });

    try {
        for await (const chunk of body) {
            buffer += decoder.decode(chunk, { stream: true });
            drainBuffer();
        }
        buffer += decoder.decode();
        drainBuffer();
    } catch (error) {
        console.warn('Responses API stream interrupted:', error?.message || error);
    }

    // The client may have already closed the connection while we were streaming; in that
    // case the response is ended/unwritable and writing again throws ERR_STREAM_WRITE_AFTER_END.
    if (to.writableEnded || !to.writable) {
        return;
    }

    // Emit a terminating chunk (with usage if we captured it) and the SSE sentinel.
    /** @type {any} */
    const finalChunk = {
        id: responseId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    };
    if (usage) {
        finalChunk.usage = usage;
    }
    try {
        to.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        to.write('data: [DONE]\n\n');
        console.info('Responses streaming request finished');
        to.end();
    } catch (error) {
        console.warn('Failed to finalize Responses API stream:', error?.message || error);
    }
}

/**
 * Decide whether a model should be routed through the Responses API based on a
 * user-configurable regex pattern.
 * @param {string} model Model id.
 * @param {string} pattern Regex pattern string.
 * @returns {boolean}
 */
export function matchesResponsesPattern(model, pattern) {
    if (!model || !pattern) {
        return false;
    }
    try {
        return new RegExp(pattern, 'i').test(model);
    } catch (error) {
        console.warn('Invalid LinkAPI Responses pattern:', pattern, error?.message || error);
        return false;
    }
}

/** Default regex for models that are only served via the Responses API. */
export const DEFAULT_RESPONSES_PATTERN = '-pro$|deep-research|^o[0-9]';

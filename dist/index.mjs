// streams/ai-stream.ts
import {
  createParser
} from "eventsource-parser";
function createEventStreamTransformer(customParser) {
  const textDecoder = new TextDecoder();
  let eventSourceParser;
  return new TransformStream({
    async start(controller) {
      eventSourceParser = createParser(
        (event) => {
          if ("data" in event && event.type === "event" && event.data === "[DONE]" || // Replicate doesn't send [DONE] but does send a 'done' event
          // @see https://replicate.com/docs/streaming
          event.event === "done") {
            controller.terminate();
            return;
          }
          if ("data" in event) {
            const parsedMessage = customParser ? customParser(event.data) : event.data;
            if (parsedMessage)
              controller.enqueue(parsedMessage);
          }
        }
      );
    },
    transform(chunk) {
      eventSourceParser.feed(textDecoder.decode(chunk));
    }
  });
}
function createCallbacksTransformer(cb) {
  const textEncoder = new TextEncoder();
  let aggregatedResponse = "";
  const callbacks = cb || {};
  return new TransformStream({
    async start() {
      if (callbacks.onStart)
        await callbacks.onStart();
    },
    async transform(message, controller) {
      controller.enqueue(textEncoder.encode(message));
      aggregatedResponse += message;
      if (callbacks.onToken)
        await callbacks.onToken(message);
    },
    async flush() {
      const isOpenAICallbacks = isOfTypeOpenAIStreamCallbacks(callbacks);
      if (callbacks.onCompletion) {
        await callbacks.onCompletion(aggregatedResponse);
      }
      if (callbacks.onFinal && !isOpenAICallbacks) {
        await callbacks.onFinal(aggregatedResponse);
      }
    }
  });
}
function isOfTypeOpenAIStreamCallbacks(callbacks) {
  return "experimental_onFunctionCall" in callbacks;
}
function trimStartOfStreamHelper() {
  let isStreamStart = true;
  return (text) => {
    if (isStreamStart) {
      text = text.trimStart();
      if (text)
        isStreamStart = false;
    }
    return text;
  };
}
function AIStream(response, customParser, callbacks) {
  if (!response.ok) {
    if (response.body) {
      const reader = response.body.getReader();
      return new ReadableStream({
        async start(controller) {
          const { done, value } = await reader.read();
          if (!done) {
            const errorText = new TextDecoder().decode(value);
            controller.error(new Error(`Response error: ${errorText}`));
          }
        }
      });
    } else {
      return new ReadableStream({
        start(controller) {
          controller.error(new Error("Response error: No response body"));
        }
      });
    }
  }
  const responseBodyStream = response.body || createEmptyReadableStream();
  return responseBodyStream.pipeThrough(createEventStreamTransformer(customParser)).pipeThrough(createCallbacksTransformer(callbacks));
}
function createEmptyReadableStream() {
  return new ReadableStream({
    start(controller) {
      controller.close();
    }
  });
}
function readableFromAsyncIterable(iterable) {
  let it = iterable[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await it.next();
      if (done)
        controller.close();
      else
        controller.enqueue(value);
    },
    async cancel(reason) {
      var _a;
      await ((_a = it.return) == null ? void 0 : _a.call(it, reason));
    }
  });
}

// shared/utils.ts
import { customAlphabet } from "nanoid/non-secure";
var nanoid = customAlphabet(
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  7
);
function createChunkDecoder(complex) {
  const decoder = new TextDecoder();
  if (!complex) {
    return function(chunk) {
      if (!chunk)
        return "";
      return decoder.decode(chunk, { stream: true });
    };
  }
  return function(chunk) {
    const decoded = decoder.decode(chunk, { stream: true }).split("\n").filter((line) => line !== "");
    return decoded.map(getStreamStringTypeAndValue).filter(Boolean);
  };
}
var StreamStringPrefixes = {
  text: 0,
  function_call: 1,
  data: 2,
  error: 3,
  control_data: 4
};
var isStreamStringEqualToType = (type, value) => value.startsWith(`${StreamStringPrefixes[type]}:`) && value.endsWith("\n");
var getStreamString = (type, value) => `${StreamStringPrefixes[type]}:${JSON.stringify(value)}
`;
var getStreamStringTypeAndValue = (line) => {
  const firstSeperatorIndex = line.indexOf(":");
  if (firstSeperatorIndex === -1) {
    throw new Error("Failed to parse stream string");
  }
  const prefix = line.slice(0, firstSeperatorIndex);
  const type = Object.keys(StreamStringPrefixes).find(
    (key) => StreamStringPrefixes[key] === Number(prefix)
  );
  const val = line.slice(firstSeperatorIndex + 1);
  let parsedVal = val;
  if (!val) {
    return { type, value: "" };
  }
  try {
    parsedVal = JSON.parse(val);
  } catch (e) {
    console.error("Failed to parse JSON value:", val);
  }
  return { type, value: parsedVal };
};
var COMPLEX_HEADER = "X-Experimental-Stream-Data";

// streams/stream-data.ts
var experimental_StreamData = class {
  constructor() {
    this.encoder = new TextEncoder();
    this.controller = null;
    // closing the stream is synchronous, but we want to return a promise
    // in case we're doing async work
    this.isClosedPromise = null;
    this.isClosedPromiseResolver = void 0;
    this.isClosed = false;
    // array to store appended data
    this.data = [];
    this.isClosedPromise = new Promise((resolve) => {
      this.isClosedPromiseResolver = resolve;
    });
    const self = this;
    this.stream = new TransformStream({
      start: async (controller) => {
        self.controller = controller;
      },
      transform: async (chunk, controller) => {
        if (self.data.length > 0) {
          const encodedData = self.encoder.encode(
            getStreamString("data", JSON.stringify(self.data))
          );
          self.data = [];
          controller.enqueue(encodedData);
        }
        controller.enqueue(chunk);
      },
      async flush(controller) {
        const warningTimeout = process.env.NODE_ENV === "development" ? setTimeout(() => {
          console.warn(
            "The data stream is hanging. Did you forget to close it with `data.close()`?"
          );
        }, 3e3) : null;
        await self.isClosedPromise;
        if (warningTimeout !== null) {
          clearTimeout(warningTimeout);
        }
        if (self.data.length) {
          const encodedData = self.encoder.encode(
            getStreamString("data", JSON.stringify(self.data))
          );
          controller.enqueue(encodedData);
        }
      }
    });
  }
  async close() {
    var _a;
    if (this.isClosed) {
      throw new Error("Data Stream has already been closed.");
    }
    if (!this.controller) {
      throw new Error("Stream controller is not initialized.");
    }
    (_a = this.isClosedPromiseResolver) == null ? void 0 : _a.call(this);
    this.isClosed = true;
  }
  append(value) {
    if (this.isClosed) {
      throw new Error("Data Stream has already been closed.");
    }
    this.data.push(value);
  }
};
function createStreamDataTransformer(experimental_streamData) {
  if (!experimental_streamData) {
    return new TransformStream({
      transform: async (chunk, controller) => {
        controller.enqueue(chunk);
      }
    });
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return new TransformStream({
    transform: async (chunk, controller) => {
      const message = decoder.decode(chunk);
      controller.enqueue(encoder.encode(getStreamString("text", message)));
    }
  });
}

// streams/openai-stream.ts
function parseOpenAIStream() {
  const extract = chunkToText();
  return (data) => {
    return extract(JSON.parse(data));
  };
}
async function* streamable(stream) {
  const extract = chunkToText();
  for await (const chunk of stream) {
    const text = extract(chunk);
    if (text)
      yield text;
  }
}
function chunkToText() {
  const trimStartOfStream = trimStartOfStreamHelper();
  let isFunctionStreamingIn;
  return (json) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
    if (isChatCompletionChunk(json) && ((_c = (_b = (_a = json.choices[0]) == null ? void 0 : _a.delta) == null ? void 0 : _b.function_call) == null ? void 0 : _c.name)) {
      isFunctionStreamingIn = true;
      return `{"function_call": {"name": "${(_e = (_d = json.choices[0]) == null ? void 0 : _d.delta) == null ? void 0 : _e.function_call.name}", "arguments": "`;
    } else if (isChatCompletionChunk(json) && ((_h = (_g = (_f = json.choices[0]) == null ? void 0 : _f.delta) == null ? void 0 : _g.function_call) == null ? void 0 : _h.arguments)) {
      const argumentChunk = json.choices[0].delta.function_call.arguments;
      let escapedPartialJson = argumentChunk.replace(/\\/g, "\\\\").replace(/\//g, "\\/").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t").replace(/\f/g, "\\f");
      return `${escapedPartialJson}`;
    } else if (isFunctionStreamingIn && (((_i = json.choices[0]) == null ? void 0 : _i.finish_reason) === "function_call" || ((_j = json.choices[0]) == null ? void 0 : _j.finish_reason) === "stop")) {
      isFunctionStreamingIn = false;
      return '"}}';
    }
    const text = trimStartOfStream(
      isChatCompletionChunk(json) && json.choices[0].delta.content ? json.choices[0].delta.content : isCompletion(json) ? json.choices[0].text : ""
    );
    return text;
  };
}
var __internal__OpenAIFnMessagesSymbol = Symbol(
  "internal_openai_fn_messages"
);
function isChatCompletionChunk(data) {
  return "choices" in data && data.choices && data.choices[0] && "delta" in data.choices[0];
}
function isCompletion(data) {
  return "choices" in data && data.choices && data.choices[0] && "text" in data.choices[0];
}
function OpenAIStream(res, callbacks) {
  const cb = callbacks;
  let stream;
  if (Symbol.asyncIterator in res) {
    stream = readableFromAsyncIterable(streamable(res)).pipeThrough(
      createCallbacksTransformer(
        (cb == null ? void 0 : cb.experimental_onFunctionCall) ? {
          ...cb,
          onFinal: void 0
        } : {
          ...cb
        }
      )
    );
  } else {
    stream = AIStream(
      res,
      parseOpenAIStream(),
      (cb == null ? void 0 : cb.experimental_onFunctionCall) ? {
        ...cb,
        onFinal: void 0
      } : {
        ...cb
      }
    );
  }
  if (cb && cb.experimental_onFunctionCall) {
    const functionCallTransformer = createFunctionCallTransformer(cb);
    return stream.pipeThrough(functionCallTransformer);
  } else {
    return stream.pipeThrough(
      createStreamDataTransformer(cb == null ? void 0 : cb.experimental_streamData)
    );
  }
}
function createFunctionCallTransformer(callbacks) {
  const textEncoder = new TextEncoder();
  let isFirstChunk = true;
  let aggregatedResponse = "";
  let aggregatedFinalCompletionResponse = "";
  let isFunctionStreamingIn = false;
  let functionCallMessages = callbacks[__internal__OpenAIFnMessagesSymbol] || [];
  const isComplexMode = callbacks == null ? void 0 : callbacks.experimental_streamData;
  const decode = createChunkDecoder();
  return new TransformStream({
    async transform(chunk, controller) {
      const message = decode(chunk);
      aggregatedFinalCompletionResponse += message;
      const shouldHandleAsFunction = isFirstChunk && message.startsWith('{"function_call":');
      if (shouldHandleAsFunction) {
        isFunctionStreamingIn = true;
        aggregatedResponse += message;
        isFirstChunk = false;
        return;
      }
      if (!isFunctionStreamingIn) {
        controller.enqueue(
          isComplexMode ? textEncoder.encode(getStreamString("text", message)) : chunk
        );
        return;
      } else {
        aggregatedResponse += message;
      }
    },
    async flush(controller) {
      try {
        const isEndOfFunction = !isFirstChunk && callbacks.experimental_onFunctionCall && isFunctionStreamingIn;
        if (isEndOfFunction && callbacks.experimental_onFunctionCall) {
          isFunctionStreamingIn = false;
          const payload = JSON.parse(aggregatedResponse);
          const argumentsPayload = JSON.parse(payload.function_call.arguments);
          let newFunctionCallMessages = [
            ...functionCallMessages
          ];
          const functionResponse = await callbacks.experimental_onFunctionCall(
            {
              name: payload.function_call.name,
              arguments: argumentsPayload
            },
            (result) => {
              newFunctionCallMessages = [
                ...functionCallMessages,
                {
                  role: "assistant",
                  content: "",
                  function_call: payload.function_call
                },
                {
                  role: "function",
                  name: payload.function_call.name,
                  content: JSON.stringify(result)
                }
              ];
              return newFunctionCallMessages;
            }
          );
          if (!functionResponse) {
            controller.enqueue(
              textEncoder.encode(
                isComplexMode ? getStreamString("function_call", aggregatedResponse) : aggregatedResponse
              )
            );
            return;
          } else if (typeof functionResponse === "string") {
            controller.enqueue(
              isComplexMode ? textEncoder.encode(getStreamString("text", functionResponse)) : textEncoder.encode(functionResponse)
            );
            return;
          }
          const filteredCallbacks = {
            ...callbacks,
            onStart: void 0
          };
          callbacks.onFinal = void 0;
          const openAIStream = OpenAIStream(functionResponse, {
            ...filteredCallbacks,
            [__internal__OpenAIFnMessagesSymbol]: newFunctionCallMessages
          });
          const reader = openAIStream.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            controller.enqueue(value);
          }
        }
      } finally {
        if (callbacks.onFinal && aggregatedFinalCompletionResponse) {
          await callbacks.onFinal(aggregatedFinalCompletionResponse);
        }
      }
    }
  });
}

// streams/streaming-text-response.ts
var StreamingTextResponse = class extends Response {
  constructor(res, init, data) {
    let processedStream = res;
    if (data) {
      processedStream = res.pipeThrough(data.stream);
    }
    super(processedStream, {
      ...init,
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        [COMPLEX_HEADER]: data ? "true" : "false",
        ...init == null ? void 0 : init.headers
      }
    });
  }
};
function streamToResponse(res, response, init) {
  response.writeHead((init == null ? void 0 : init.status) || 200, {
    "Content-Type": "text/plain; charset=utf-8",
    ...init == null ? void 0 : init.headers
  });
  const reader = res.getReader();
  function read() {
    reader.read().then(({ done, value }) => {
      if (done) {
        response.end();
        return;
      }
      response.write(value);
      read();
    });
  }
  read();
}

// streams/huggingface-stream.ts
function createParser2(res) {
  const trimStartOfStream = trimStartOfStreamHelper();
  return new ReadableStream({
    async pull(controller) {
      var _a, _b;
      const { value, done } = await res.next();
      if (done) {
        controller.close();
        return;
      }
      const text = trimStartOfStream((_b = (_a = value.token) == null ? void 0 : _a.text) != null ? _b : "");
      if (!text)
        return;
      if (value.generated_text != null && value.generated_text.length > 0) {
        return;
      }
      if (text === "</s>" || text === "<|endoftext|>" || text === "<|end|>") {
        return;
      }
      controller.enqueue(text);
    }
  });
}
function HuggingFaceStream(res, callbacks) {
  return createParser2(res).pipeThrough(createCallbacksTransformer(callbacks)).pipeThrough(
    createStreamDataTransformer(callbacks == null ? void 0 : callbacks.experimental_streamData)
  );
}

// streams/cohere-stream.ts
var utf8Decoder = new TextDecoder("utf-8");
async function processLines(lines, controller) {
  for (const line of lines) {
    const { text, is_finished } = JSON.parse(line);
    if (!is_finished) {
      controller.enqueue(text);
    }
  }
}
async function readAndProcessLines(reader, controller) {
  let segment = "";
  while (true) {
    const { value: chunk, done } = await reader.read();
    if (done) {
      break;
    }
    segment += utf8Decoder.decode(chunk, { stream: true });
    const linesArray = segment.split(/\r\n|\n|\r/g);
    segment = linesArray.pop() || "";
    await processLines(linesArray, controller);
  }
  if (segment) {
    const linesArray = [segment];
    await processLines(linesArray, controller);
  }
  controller.close();
}
function createParser3(res) {
  var _a;
  const reader = (_a = res.body) == null ? void 0 : _a.getReader();
  return new ReadableStream({
    async start(controller) {
      if (!reader) {
        controller.close();
        return;
      }
      await readAndProcessLines(reader, controller);
    }
  });
}
function CohereStream(reader, callbacks) {
  return createParser3(reader).pipeThrough(createCallbacksTransformer(callbacks)).pipeThrough(
    createStreamDataTransformer(callbacks == null ? void 0 : callbacks.experimental_streamData)
  );
}

// streams/anthropic-stream.ts
function parseAnthropicStream() {
  let previous = "";
  return (data) => {
    const json = JSON.parse(data);
    if ("error" in json) {
      throw new Error(`${json.error.type}: ${json.error.message}`);
    }
    if (!("completion" in json)) {
      return;
    }
    const text = json.completion;
    if (!previous || text.length > previous.length && text.startsWith(previous)) {
      const delta = text.slice(previous.length);
      previous = text;
      return delta;
    }
    return text;
  };
}
async function* streamable2(stream) {
  for await (const chunk of stream) {
    const text = chunk.completion;
    if (text)
      yield text;
  }
}
function AnthropicStream(res, cb) {
  if (Symbol.asyncIterator in res) {
    return readableFromAsyncIterable(streamable2(res)).pipeThrough(createCallbacksTransformer(cb)).pipeThrough(createStreamDataTransformer(cb == null ? void 0 : cb.experimental_streamData));
  } else {
    return AIStream(res, parseAnthropicStream(), cb).pipeThrough(
      createStreamDataTransformer(cb == null ? void 0 : cb.experimental_streamData)
    );
  }
}

// streams/langchain-stream.ts
function LangChainStream(callbacks) {
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const runs = /* @__PURE__ */ new Set();
  const handleError = async (e, runId) => {
    runs.delete(runId);
    await writer.ready;
    await writer.abort(e);
  };
  const handleStart = async (runId) => {
    runs.add(runId);
  };
  const handleEnd = async (runId) => {
    runs.delete(runId);
    if (runs.size === 0) {
      await writer.ready;
      await writer.close();
    }
  };
  return {
    stream: stream.readable.pipeThrough(createCallbacksTransformer(callbacks)).pipeThrough(
      createStreamDataTransformer(callbacks == null ? void 0 : callbacks.experimental_streamData)
    ),
    writer,
    handlers: {
      handleLLMNewToken: async (token) => {
        await writer.ready;
        await writer.write(token);
      },
      handleLLMStart: async (_llm, _prompts, runId) => {
        handleStart(runId);
      },
      handleLLMEnd: async (_output, runId) => {
        await handleEnd(runId);
      },
      handleLLMError: async (e, runId) => {
        await handleError(e, runId);
      },
      handleChainStart: async (_chain, _inputs, runId) => {
        handleStart(runId);
      },
      handleChainEnd: async (_outputs, runId) => {
        await handleEnd(runId);
      },
      handleChainError: async (e, runId) => {
        await handleError(e, runId);
      },
      handleToolStart: async (_tool, _input, runId) => {
        handleStart(runId);
      },
      handleToolEnd: async (_output, runId) => {
        await handleEnd(runId);
      },
      handleToolError: async (e, runId) => {
        await handleError(e, runId);
      }
    }
  };
}

// streams/replicate-stream.ts
async function ReplicateStream(res, cb, options) {
  var _a;
  const url = (_a = res.urls) == null ? void 0 : _a.stream;
  if (!url) {
    if (res.error)
      throw new Error(res.error);
    else
      throw new Error("Missing stream URL in Replicate response");
  }
  const eventStream = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      ...options == null ? void 0 : options.headers
    }
  });
  return AIStream(eventStream, void 0, cb).pipeThrough(
    createStreamDataTransformer(cb == null ? void 0 : cb.experimental_streamData)
  );
}

// react/parse-complex-response.ts
async function parseComplexResponse({
  reader,
  abortControllerRef,
  update,
  onFinish
}) {
  const decode = createChunkDecoder(true);
  const createdAt = /* @__PURE__ */ new Date();
  const prefixMap = {};
  const NEWLINE = "\n".charCodeAt(0);
  let chunks = [];
  let totalLength = 0;
  while (true) {
    const { value } = await reader.read();
    if (value) {
      chunks.push(value);
      totalLength += value.length;
      if (value[value.length - 1] !== NEWLINE) {
        continue;
      }
    }
    if (chunks.length === 0) {
      break;
    }
    let concatenatedChunks = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      concatenatedChunks.set(chunk, offset);
      offset += chunk.length;
    }
    chunks.length = 0;
    totalLength = 0;
    const lines = decode(concatenatedChunks);
    if (typeof lines === "string") {
      throw new Error(
        "Invalid response format. Complex mode was set but the response is a string. This should never happen."
      );
    }
    for (const { type, value: value2 } of lines) {
      if (type === "text") {
        if (prefixMap["text"]) {
          prefixMap["text"] = {
            ...prefixMap["text"],
            content: (prefixMap["text"].content || "") + value2
          };
        } else {
          prefixMap["text"] = {
            id: nanoid(),
            role: "assistant",
            content: value2,
            createdAt
          };
        }
      }
      let functionCallMessage = null;
      if (type === "function_call") {
        prefixMap["function_call"] = value2;
        let functionCall = prefixMap["function_call"];
        if (functionCall && typeof functionCall === "string") {
          const parsedFunctionCall = JSON.parse(
            functionCall
          ).function_call;
          functionCallMessage = {
            id: nanoid(),
            role: "assistant",
            content: "",
            function_call: parsedFunctionCall,
            name: parsedFunctionCall.name,
            createdAt
          };
          prefixMap["function_call"] = functionCallMessage;
        }
      }
      if (type === "data") {
        const parsedValue = JSON.parse(value2);
        if (prefixMap["data"]) {
          prefixMap["data"] = [...prefixMap["data"], ...parsedValue];
        } else {
          prefixMap["data"] = parsedValue;
        }
      }
      const data = prefixMap["data"];
      const responseMessage = prefixMap["text"];
      const merged = [functionCallMessage, responseMessage].filter(
        Boolean
      );
      update(merged, data);
      if ((abortControllerRef == null ? void 0 : abortControllerRef.current) === null) {
        reader.cancel();
        break;
      }
    }
  }
  onFinish == null ? void 0 : onFinish(prefixMap);
  return prefixMap;
}

// streams/streaming-react-response.ts
var experimental_StreamingReactResponse = class {
  constructor(res, options) {
    let resolveFunc = () => {
    };
    let next = new Promise((resolve) => {
      resolveFunc = resolve;
    });
    if (options == null ? void 0 : options.data) {
      const processedStream = res.pipeThrough(
        options.data.stream
      );
      let lastPayload = void 0;
      parseComplexResponse({
        reader: processedStream.getReader(),
        update: (merged, data) => {
          var _a, _b, _c;
          const content2 = (_b = (_a = merged[0]) == null ? void 0 : _a.content) != null ? _b : "";
          const ui = ((_c = options == null ? void 0 : options.ui) == null ? void 0 : _c.call(options, { content: content2, data })) || content2;
          const payload = { ui, content: content2 };
          const resolvePrevious = resolveFunc;
          const nextRow = new Promise((resolve) => {
            resolveFunc = resolve;
          });
          resolvePrevious({
            next: nextRow,
            ...payload
          });
          lastPayload = payload;
        },
        onFinish: () => {
          if (lastPayload !== void 0) {
            resolveFunc({
              next: null,
              ...lastPayload
            });
          }
        }
      });
      return next;
    }
    let content = "";
    const decode = createChunkDecoder();
    const reader = res.getReader();
    async function readChunk() {
      var _a;
      const { done, value } = await reader.read();
      if (!done) {
        content += decode(value);
      }
      const ui = ((_a = options == null ? void 0 : options.ui) == null ? void 0 : _a.call(options, { content })) || content;
      const payload = {
        ui,
        content
      };
      const resolvePrevious = resolveFunc;
      const nextRow = done ? null : new Promise((resolve) => {
        resolveFunc = resolve;
      });
      resolvePrevious({
        next: nextRow,
        ...payload
      });
      if (done) {
        return;
      }
      await readChunk();
    }
    readChunk();
    return next;
  }
};

// streams/assistant-response.ts
function experimental_AssistantResponse({ threadId, messageId }, process2) {
  const stream = new ReadableStream({
    async start(controller) {
      var _a;
      const textEncoder = new TextEncoder();
      const sendMessage = (message) => {
        controller.enqueue(
          textEncoder.encode(getStreamString("text", message))
        );
      };
      const sendError = (errorMessage) => {
        controller.enqueue(
          textEncoder.encode(getStreamString("error", errorMessage))
        );
      };
      controller.enqueue(
        textEncoder.encode(
          getStreamString("control_data", {
            threadId,
            messageId
          })
        )
      );
      try {
        await process2({
          threadId,
          messageId,
          sendMessage
        });
      } catch (error) {
        sendError((_a = error.message) != null ? _a : `${error}`);
      } finally {
        controller.close();
      }
    },
    pull(controller) {
    },
    cancel() {
    }
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8"
    }
  });
}
export {
  AIStream,
  AnthropicStream,
  COMPLEX_HEADER,
  CohereStream,
  HuggingFaceStream,
  LangChainStream,
  OpenAIStream,
  ReplicateStream,
  StreamStringPrefixes,
  StreamingTextResponse,
  createCallbacksTransformer,
  createChunkDecoder,
  createEventStreamTransformer,
  createStreamDataTransformer,
  experimental_AssistantResponse,
  experimental_StreamData,
  experimental_StreamingReactResponse,
  getStreamString,
  getStreamStringTypeAndValue,
  isStreamStringEqualToType,
  nanoid,
  readableFromAsyncIterable,
  streamToResponse,
  trimStartOfStreamHelper
};

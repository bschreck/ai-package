"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// solid/index.ts
var solid_exports = {};
__export(solid_exports, {
  useChat: () => useChat,
  useCompletion: () => useCompletion
});
module.exports = __toCommonJS(solid_exports);

// solid/use-chat.ts
var import_solid_js = require("solid-js");
var import_solid_swr_store = require("solid-swr-store");
var import_swr_store = require("swr-store");

// shared/utils.ts
var import_non_secure = require("nanoid/non-secure");
var nanoid = (0, import_non_secure.customAlphabet)(
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

// solid/use-chat.ts
var uniqueId = 0;
var store = {};
var chatApiStore = (0, import_swr_store.createSWRStore)({
  get: async (key) => {
    var _a;
    return (_a = store[key]) != null ? _a : [];
  }
});
function useChat({
  api = "/api/chat",
  id,
  initialMessages = [],
  initialInput = "",
  sendExtraMessageFields,
  onResponse,
  onFinish,
  onError,
  credentials,
  headers,
  body
} = {}) {
  const chatId = id || `chat-${uniqueId++}`;
  const key = `${api}|${chatId}`;
  const data = (0, import_solid_swr_store.useSWRStore)(chatApiStore, () => [key], {
    initialData: initialMessages
  });
  const mutate = (data2) => {
    store[key] = data2;
    return chatApiStore.mutate([key], {
      status: "success",
      data: data2
    });
  };
  const messages = data;
  const [error, setError] = (0, import_solid_js.createSignal)(void 0);
  const [isLoading, setIsLoading] = (0, import_solid_js.createSignal)(false);
  let abortController = null;
  async function triggerRequest(messagesSnapshot, options) {
    try {
      setError(void 0);
      setIsLoading(true);
      abortController = new AbortController();
      const previousMessages = chatApiStore.get([key], {
        shouldRevalidate: false
      });
      mutate(messagesSnapshot);
      const res = await fetch(api, {
        method: "POST",
        body: JSON.stringify({
          messages: sendExtraMessageFields ? messagesSnapshot : messagesSnapshot.map(
            ({ role, content, name, function_call }) => ({
              role,
              content,
              ...name !== void 0 && { name },
              ...function_call !== void 0 && {
                function_call
              }
            })
          ),
          ...body,
          ...options == null ? void 0 : options.body
        }),
        headers: {
          ...headers,
          ...options == null ? void 0 : options.headers
        },
        signal: abortController.signal,
        credentials
      }).catch((err) => {
        if (previousMessages.status === "success") {
          mutate(previousMessages.data);
        }
        throw err;
      });
      if (onResponse) {
        try {
          await onResponse(res);
        } catch (err) {
          throw err;
        }
      }
      if (!res.ok) {
        if (previousMessages.status === "success") {
          mutate(previousMessages.data);
        }
        throw new Error(
          await res.text() || "Failed to fetch the chat response."
        );
      }
      if (!res.body) {
        throw new Error("The response body is empty.");
      }
      let result = "";
      const createdAt = /* @__PURE__ */ new Date();
      const replyId = nanoid();
      const reader = res.body.getReader();
      const decoder = createChunkDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        result += decoder(value);
        mutate([
          ...messagesSnapshot,
          {
            id: replyId,
            createdAt,
            content: result,
            role: "assistant"
          }
        ]);
        if (abortController === null) {
          reader.cancel();
          break;
        }
      }
      if (onFinish) {
        onFinish({
          id: replyId,
          createdAt,
          content: result,
          role: "assistant"
        });
      }
      abortController = null;
      return result;
    } catch (err) {
      if (err.name === "AbortError") {
        abortController = null;
        return null;
      }
      if (onError && err instanceof Error) {
        onError(err);
      }
      setError(err);
    } finally {
      setIsLoading(false);
    }
  }
  const append = async (message, options) => {
    var _a;
    if (!message.id) {
      message.id = nanoid();
    }
    return triggerRequest(
      ((_a = messages()) != null ? _a : []).concat(message),
      options
    );
  };
  const reload = async (options) => {
    const messagesSnapshot = messages();
    if (!messagesSnapshot || messagesSnapshot.length === 0)
      return null;
    const lastMessage = messagesSnapshot[messagesSnapshot.length - 1];
    if (lastMessage.role === "assistant") {
      return triggerRequest(messagesSnapshot.slice(0, -1), options);
    }
    return triggerRequest(messagesSnapshot, options);
  };
  const stop = () => {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
  };
  const setMessages = (messages2) => {
    mutate(messages2);
  };
  const [input, setInput] = (0, import_solid_js.createSignal)(initialInput);
  const handleSubmit = (e) => {
    e.preventDefault();
    const inputValue = input();
    if (!inputValue)
      return;
    append({
      content: inputValue,
      role: "user",
      createdAt: /* @__PURE__ */ new Date()
    });
    setInput("");
  };
  return {
    messages,
    append,
    error,
    reload,
    stop,
    setMessages,
    input,
    setInput,
    handleSubmit,
    isLoading
  };
}

// solid/use-completion.ts
var import_solid_js2 = require("solid-js");
var import_swr_store2 = require("swr-store");
var import_solid_swr_store2 = require("solid-swr-store");
var uniqueId2 = 0;
var store2 = {};
var completionApiStore = (0, import_swr_store2.createSWRStore)({
  get: async (key) => {
    var _a;
    return (_a = store2[key]) != null ? _a : [];
  }
});
function useCompletion({
  api = "/api/completion",
  id,
  initialCompletion = "",
  initialInput = "",
  credentials,
  headers,
  body,
  onResponse,
  onFinish,
  onError
} = {}) {
  const completionId = id || `completion-${uniqueId2++}`;
  const key = `${api}|${completionId}`;
  const data = (0, import_solid_swr_store2.useSWRStore)(completionApiStore, () => [key], {
    initialData: initialCompletion
  });
  const mutate = (data2) => {
    store2[key] = data2;
    return completionApiStore.mutate([key], {
      data: data2,
      status: "success"
    });
  };
  const completion = data;
  const [error, setError] = (0, import_solid_js2.createSignal)(void 0);
  const [isLoading, setIsLoading] = (0, import_solid_js2.createSignal)(false);
  let abortController = null;
  async function triggerRequest(prompt, options) {
    try {
      setError(void 0);
      setIsLoading(true);
      abortController = new AbortController();
      mutate("");
      const res = await fetch(api, {
        method: "POST",
        body: JSON.stringify({
          prompt,
          ...body,
          ...options == null ? void 0 : options.body
        }),
        headers: {
          ...headers,
          ...options == null ? void 0 : options.headers
        },
        signal: abortController.signal,
        credentials
      }).catch((err) => {
        throw err;
      });
      if (onResponse) {
        try {
          await onResponse(res);
        } catch (err) {
          throw err;
        }
      }
      if (!res.ok) {
        throw new Error(
          await res.text() || "Failed to fetch the chat response."
        );
      }
      if (!res.body) {
        throw new Error("The response body is empty.");
      }
      let result = "";
      const reader = res.body.getReader();
      const decoder = createChunkDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        result += decoder(value);
        mutate(result);
        if (abortController === null) {
          reader.cancel();
          break;
        }
      }
      if (onFinish) {
        onFinish(prompt, result);
      }
      abortController = null;
      return result;
    } catch (err) {
      if (err.name === "AbortError") {
        abortController = null;
        return null;
      }
      if (onError && error instanceof Error) {
        onError(error);
      }
      setError(err);
    } finally {
      setIsLoading(false);
    }
  }
  const complete = async (prompt, options) => {
    return triggerRequest(prompt, options);
  };
  const stop = () => {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
  };
  const setCompletion = (completion2) => {
    mutate(completion2);
  };
  const [input, setInput] = (0, import_solid_js2.createSignal)(initialInput);
  const handleSubmit = (e) => {
    e.preventDefault();
    const inputValue = input();
    if (!inputValue)
      return;
    return complete(inputValue);
  };
  return {
    completion,
    complete,
    error,
    stop,
    setCompletion,
    input,
    setInput,
    handleSubmit,
    isLoading
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  useChat,
  useCompletion
});

// vue/use-chat.ts
import swrv from "swrv";
import { ref, unref } from "vue";

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

// vue/use-chat.ts
var uniqueId = 0;
var useSWRV = swrv.default || swrv;
var store = {};
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
  var _a;
  const chatId = id || `chat-${uniqueId++}`;
  const key = `${api}|${chatId}`;
  const { data, mutate: originalMutate } = useSWRV(
    key,
    () => store[key] || initialMessages
  );
  const { data: isLoading, mutate: mutateLoading } = useSWRV(
    `${chatId}-loading`,
    null
  );
  (_a = isLoading.value) != null ? _a : isLoading.value = false;
  data.value || (data.value = initialMessages);
  const mutate = (data2) => {
    store[key] = data2;
    return originalMutate();
  };
  const messages = data;
  const error = ref(void 0);
  let abortController = null;
  async function triggerRequest(messagesSnapshot, options) {
    try {
      error.value = void 0;
      mutateLoading(() => true);
      abortController = new AbortController();
      const previousMessages = messages.value;
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
          ...unref(body),
          // Use unref to unwrap the ref value
          ...options == null ? void 0 : options.body
        }),
        headers: {
          ...headers,
          ...options == null ? void 0 : options.headers
        },
        signal: abortController.signal,
        credentials
      }).catch((err) => {
        mutate(previousMessages);
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
        mutate(previousMessages);
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
      error.value = err;
    } finally {
      mutateLoading(() => false);
    }
  }
  const append = async (message, options) => {
    if (!message.id) {
      message.id = nanoid();
    }
    return triggerRequest(messages.value.concat(message), options);
  };
  const reload = async (options) => {
    const messagesSnapshot = messages.value;
    if (messagesSnapshot.length === 0)
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
  const input = ref(initialInput);
  const handleSubmit = (e) => {
    e.preventDefault();
    const inputValue = input.value;
    if (!inputValue)
      return;
    append({
      content: inputValue,
      role: "user"
    });
    input.value = "";
  };
  return {
    messages,
    append,
    error,
    reload,
    stop,
    setMessages,
    input,
    handleSubmit,
    isLoading
  };
}

// vue/use-completion.ts
import swrv2 from "swrv";
import { ref as ref2, unref as unref2 } from "vue";
var uniqueId2 = 0;
var useSWRV2 = swrv2.default || swrv2;
var store2 = {};
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
  var _a;
  const completionId = id || `completion-${uniqueId2++}`;
  const key = `${api}|${completionId}`;
  const { data, mutate: originalMutate } = useSWRV2(
    key,
    () => store2[key] || initialCompletion
  );
  const { data: isLoading, mutate: mutateLoading } = useSWRV2(
    `${completionId}-loading`,
    null
  );
  (_a = isLoading.value) != null ? _a : isLoading.value = false;
  data.value || (data.value = initialCompletion);
  const mutate = (data2) => {
    store2[key] = data2;
    return originalMutate();
  };
  const completion = data;
  const error = ref2(void 0);
  let abortController = null;
  async function triggerRequest(prompt, options) {
    try {
      error.value = void 0;
      mutateLoading(() => true);
      abortController = new AbortController();
      mutate("");
      const res = await fetch(api, {
        method: "POST",
        body: JSON.stringify({
          prompt,
          ...unref2(body),
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
      error.value = err;
    } finally {
      mutateLoading(() => false);
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
  const input = ref2(initialInput);
  const handleSubmit = (e) => {
    e.preventDefault();
    const inputValue = input.value;
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
    handleSubmit,
    isLoading
  };
}
export {
  useChat,
  useCompletion
};

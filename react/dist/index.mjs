'use client'

// react/use-chat.ts
import { useCallback, useEffect, useId, useRef, useState } from "react";
import useSWR from "swr";

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
var COMPLEX_HEADER = "X-Experimental-Stream-Data";

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

// react/use-chat.ts
var getStreamedResponse = async (api, chatRequest, mutate, mutateStreamData, existingData, extraMetadataRef, messagesRef, abortControllerRef, onFinish, onResponse, sendExtraMessageFields) => {
  var _a, _b;
  const previousMessages = messagesRef.current;
  mutate(chatRequest.messages, false);
  const constructedMessagesPayload = sendExtraMessageFields ? chatRequest.messages : chatRequest.messages.map(({ role, content, name, function_call }) => ({
    role,
    content,
    ...name !== void 0 && { name },
    ...function_call !== void 0 && {
      function_call
    }
  }));
  if (typeof api !== "string") {
    const replyId = nanoid();
    const createdAt = /* @__PURE__ */ new Date();
    let responseMessage = {
      id: replyId,
      createdAt,
      content: "",
      role: "assistant"
    };
    async function readRow(promise) {
      const { content, ui, next } = await promise;
      responseMessage["content"] = content;
      responseMessage["ui"] = await ui;
      mutate([...chatRequest.messages, { ...responseMessage }], false);
      if (next) {
        await readRow(next);
      }
    }
    try {
      const promise = api({
        messages: constructedMessagesPayload,
        data: chatRequest.data
      });
      await readRow(promise);
    } catch (e) {
      mutate(previousMessages, false);
      throw e;
    }
    if (onFinish) {
      onFinish(responseMessage);
    }
    return responseMessage;
  }
  const res = await fetch(api, {
    method: "POST",
    body: JSON.stringify({
      messages: constructedMessagesPayload,
      data: chatRequest.data,
      ...extraMetadataRef.current.body,
      ...(_a = chatRequest.options) == null ? void 0 : _a.body,
      ...chatRequest.functions !== void 0 && {
        functions: chatRequest.functions
      },
      ...chatRequest.function_call !== void 0 && {
        function_call: chatRequest.function_call
      }
    }),
    credentials: extraMetadataRef.current.credentials,
    headers: {
      ...extraMetadataRef.current.headers,
      ...(_b = chatRequest.options) == null ? void 0 : _b.headers
    },
    ...abortControllerRef.current !== null && {
      signal: abortControllerRef.current.signal
    }
  }).catch((err) => {
    mutate(previousMessages, false);
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
    mutate(previousMessages, false);
    throw new Error(await res.text() || "Failed to fetch the chat response.");
  }
  if (!res.body) {
    throw new Error("The response body is empty.");
  }
  const isComplexMode = res.headers.get(COMPLEX_HEADER) === "true";
  let responseMessages = [];
  const reader = res.body.getReader();
  let responseData = [];
  if (isComplexMode) {
    const prefixMap = await parseComplexResponse({
      reader,
      abortControllerRef,
      update(merged, data) {
        mutate([...chatRequest.messages, ...merged], false);
        mutateStreamData([...existingData || [], ...data || []], false);
      }
    });
    for (const [type, item] of Object.entries(prefixMap)) {
      if (onFinish && type === "text") {
        onFinish(item);
      }
      if (type === "data") {
        responseData.push(item);
      } else {
        responseMessages.push(item);
      }
    }
    return { messages: responseMessages, data: responseData };
  } else {
    const createdAt = /* @__PURE__ */ new Date();
    const decode = createChunkDecoder(false);
    let streamedResponse = "";
    const replyId = nanoid();
    let responseMessage = {
      id: replyId,
      createdAt,
      content: "",
      role: "assistant"
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      streamedResponse += decode(value);
      if (streamedResponse.startsWith('{"function_call":')) {
        responseMessage["function_call"] = streamedResponse;
      } else {
        responseMessage["content"] = streamedResponse;
      }
      mutate([...chatRequest.messages, { ...responseMessage }], false);
      if (abortControllerRef.current === null) {
        reader.cancel();
        break;
      }
    }
    if (streamedResponse.startsWith('{"function_call":')) {
      const parsedFunctionCall = JSON.parse(streamedResponse).function_call;
      responseMessage["function_call"] = parsedFunctionCall;
      mutate([...chatRequest.messages, { ...responseMessage }]);
    }
    if (onFinish) {
      onFinish(responseMessage);
    }
    return responseMessage;
  }
};
function useChat({
  api = "/api/chat",
  id,
  initialMessages,
  initialInput = "",
  sendExtraMessageFields,
  experimental_onFunctionCall,
  onResponse,
  onFinish,
  onError,
  credentials,
  headers,
  body
} = {}) {
  const hookId = useId();
  const chatId = id || hookId;
  const [initialMessagesFallback] = useState([]);
  const { data: messages, mutate } = useSWR([api, chatId], null, {
    fallbackData: initialMessages != null ? initialMessages : initialMessagesFallback
  });
  const { data: isLoading = false, mutate: mutateLoading } = useSWR(
    [chatId, "loading"],
    null
  );
  const { data: streamData, mutate: mutateStreamData } = useSWR(
    [chatId, "streamData"],
    null
  );
  const messagesRef = useRef(messages || []);
  useEffect(() => {
    messagesRef.current = messages || [];
  }, [messages]);
  const abortControllerRef = useRef(null);
  const extraMetadataRef = useRef({
    credentials,
    headers,
    body
  });
  useEffect(() => {
    extraMetadataRef.current = {
      credentials,
      headers,
      body
    };
  }, [credentials, headers, body]);
  const [error, setError] = useState();
  const triggerRequest = useCallback(
    async (chatRequest) => {
      try {
        mutateLoading(true);
        setError(void 0);
        const abortController = new AbortController();
        abortControllerRef.current = abortController;
        while (true) {
          const messagesAndDataOrJustMessage = await getStreamedResponse(
            api,
            chatRequest,
            mutate,
            mutateStreamData,
            streamData,
            extraMetadataRef,
            messagesRef,
            abortControllerRef,
            onFinish,
            onResponse,
            sendExtraMessageFields
          );
          if ("messages" in messagesAndDataOrJustMessage) {
            let hasFollowingResponse = false;
            for (const message of messagesAndDataOrJustMessage.messages) {
              if (message.function_call === void 0 || typeof message.function_call === "string") {
                continue;
              }
              hasFollowingResponse = true;
              if (experimental_onFunctionCall) {
                const functionCall = message.function_call;
                const functionCallResponse = await experimental_onFunctionCall(
                  messagesRef.current,
                  functionCall
                );
                if (functionCallResponse === void 0) {
                  hasFollowingResponse = false;
                  break;
                }
                chatRequest = functionCallResponse;
              }
            }
            if (!hasFollowingResponse) {
              break;
            }
          } else {
            const streamedResponseMessage = messagesAndDataOrJustMessage;
            if (streamedResponseMessage.function_call === void 0 || typeof streamedResponseMessage.function_call === "string") {
              break;
            }
            if (experimental_onFunctionCall) {
              const functionCall = streamedResponseMessage.function_call;
              const functionCallResponse = await experimental_onFunctionCall(
                messagesRef.current,
                functionCall
              );
              if (functionCallResponse === void 0)
                break;
              chatRequest = functionCallResponse;
            }
          }
        }
        abortControllerRef.current = null;
      } catch (err) {
        if (err.name === "AbortError") {
          abortControllerRef.current = null;
          return null;
        }
        if (onError && err instanceof Error) {
          onError(err);
        }
        setError(err);
      } finally {
        mutateLoading(false);
      }
    },
    [
      mutate,
      mutateLoading,
      api,
      extraMetadataRef,
      onResponse,
      onFinish,
      onError,
      setError,
      mutateStreamData,
      streamData,
      sendExtraMessageFields,
      experimental_onFunctionCall,
      messagesRef.current,
      abortControllerRef.current
    ]
  );
  const append = useCallback(
    async (message, { options, functions, function_call, data } = {}) => {
      if (!message.id) {
        message.id = nanoid();
      }
      const chatRequest = {
        messages: messagesRef.current.concat(message),
        options,
        data,
        ...functions !== void 0 && { functions },
        ...function_call !== void 0 && { function_call }
      };
      return triggerRequest(chatRequest);
    },
    [triggerRequest]
  );
  const reload = useCallback(
    async ({ options, functions, function_call } = {}) => {
      if (messagesRef.current.length === 0)
        return null;
      const lastMessage = messagesRef.current[messagesRef.current.length - 1];
      if (lastMessage.role === "assistant") {
        const chatRequest2 = {
          messages: messagesRef.current.slice(0, -1),
          options,
          ...functions !== void 0 && { functions },
          ...function_call !== void 0 && { function_call }
        };
        return triggerRequest(chatRequest2);
      }
      const chatRequest = {
        messages: messagesRef.current,
        options,
        ...functions !== void 0 && { functions },
        ...function_call !== void 0 && { function_call }
      };
      return triggerRequest(chatRequest);
    },
    [triggerRequest]
  );
  const stop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);
  const setMessages = useCallback(
    (messages2) => {
      mutate(messages2, false);
      messagesRef.current = messages2;
    },
    [mutate]
  );
  const [input, setInput] = useState(initialInput);
  const handleSubmit = useCallback(
    (e, options = {}, metadata) => {
      if (metadata) {
        extraMetadataRef.current = {
          ...extraMetadataRef.current,
          ...metadata
        };
      }
      e.preventDefault();
      if (!input)
        return;
      append(
        {
          content: input,
          role: "user",
          createdAt: /* @__PURE__ */ new Date()
        },
        options
      );
      setInput("");
    },
    [input, append]
  );
  const handleInputChange = (e) => {
    setInput(e.target.value);
  };
  return {
    messages: messages || [],
    error,
    append,
    reload,
    stop,
    setMessages,
    input,
    setInput,
    handleInputChange,
    handleSubmit,
    isLoading,
    data: streamData
  };
}

// react/use-completion.ts
import { useCallback as useCallback2, useEffect as useEffect2, useId as useId2, useRef as useRef2, useState as useState2 } from "react";
import useSWR2 from "swr";
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
  const hookId = useId2();
  const completionId = id || hookId;
  const { data, mutate } = useSWR2([api, completionId], null, {
    fallbackData: initialCompletion
  });
  const { data: isLoading = false, mutate: mutateLoading } = useSWR2(
    [completionId, "loading"],
    null
  );
  const [error, setError] = useState2(void 0);
  const completion = data;
  const [abortController, setAbortController] = useState2(null);
  const extraMetadataRef = useRef2({
    credentials,
    headers,
    body
  });
  useEffect2(() => {
    extraMetadataRef.current = {
      credentials,
      headers,
      body
    };
  }, [credentials, headers, body]);
  const triggerRequest = useCallback2(
    async (prompt, options) => {
      try {
        mutateLoading(true);
        setError(void 0);
        const abortController2 = new AbortController();
        setAbortController(abortController2);
        mutate("", false);
        const res = await fetch(api, {
          method: "POST",
          body: JSON.stringify({
            prompt,
            ...extraMetadataRef.current.body,
            ...options == null ? void 0 : options.body
          }),
          credentials: extraMetadataRef.current.credentials,
          headers: {
            ...extraMetadataRef.current.headers,
            ...options == null ? void 0 : options.headers
          },
          signal: abortController2.signal
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
          mutate(result, false);
          if (abortController2 === null) {
            reader.cancel();
            break;
          }
        }
        if (onFinish) {
          onFinish(prompt, result);
        }
        setAbortController(null);
        return result;
      } catch (err) {
        if (err.name === "AbortError") {
          setAbortController(null);
          return null;
        }
        if (err instanceof Error) {
          if (onError) {
            onError(err);
          }
        }
        setError(err);
      } finally {
        mutateLoading(false);
      }
    },
    [
      mutate,
      mutateLoading,
      api,
      extraMetadataRef,
      setAbortController,
      onResponse,
      onFinish,
      onError,
      setError
    ]
  );
  const stop = useCallback2(() => {
    if (abortController) {
      abortController.abort();
      setAbortController(null);
    }
  }, [abortController]);
  const setCompletion = useCallback2(
    (completion2) => {
      mutate(completion2, false);
    },
    [mutate]
  );
  const complete = useCallback2(
    async (prompt, options) => {
      return triggerRequest(prompt, options);
    },
    [triggerRequest]
  );
  const [input, setInput] = useState2(initialInput);
  const handleSubmit = useCallback2(
    (e) => {
      e.preventDefault();
      if (!input)
        return;
      return complete(input);
    },
    [input, complete]
  );
  const handleInputChange = (e) => {
    setInput(e.target.value);
  };
  return {
    completion,
    complete,
    error,
    setCompletion,
    stop,
    input,
    setInput,
    handleInputChange,
    handleSubmit,
    isLoading
  };
}

// react/use-assistant.ts
import { useState as useState3 } from "react";

// shared/process-message-stream.ts
async function processMessageStream(reader, processMessage) {
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (buffer.length > 0) {
        processMessage(buffer);
      }
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let endIndex;
    while ((endIndex = buffer.indexOf("\n")) !== -1) {
      processMessage(buffer.substring(0, endIndex).trim());
      buffer = buffer.substring(endIndex + 1);
    }
  }
}

// react/use-assistant.ts
function useAssistant_experimental({
  api,
  threadId: threadIdParam
}) {
  const [messages, setMessages] = useState3([]);
  const [input, setInput] = useState3("");
  const [threadId, setThreadId] = useState3(void 0);
  const [status, setStatus] = useState3("awaiting_message");
  const [error, setError] = useState3(void 0);
  const handleInputChange = (e) => {
    setInput(e.target.value);
  };
  const submitMessage = async (e) => {
    var _a;
    e.preventDefault();
    if (input === "") {
      return;
    }
    setStatus("in_progress");
    setMessages((messages2) => [
      ...messages2,
      { id: "", role: "user", content: input }
    ]);
    setInput("");
    const result = await fetch(api, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // always use user-provided threadId when available:
        threadId: (_a = threadIdParam != null ? threadIdParam : threadId) != null ? _a : null,
        message: input
      })
    });
    if (result.body == null) {
      throw new Error("The response body is empty.");
    }
    await processMessageStream(result.body.getReader(), (message) => {
      try {
        const { type, value } = getStreamStringTypeAndValue(message);
        const messageContent = value;
        switch (type) {
          case "text": {
            setMessages((messages2) => [
              ...messages2,
              {
                id: messageContent.id,
                role: messageContent.role,
                content: messageContent.content[0].text.value
              }
            ]);
            break;
          }
          case "error": {
            setError(messageContent);
            break;
          }
          case "control_data": {
            setThreadId(messageContent.threadId);
            setMessages((messages2) => {
              const lastMessage = messages2[messages2.length - 1];
              lastMessage.id = messageContent.messageId;
              return [...messages2.slice(0, messages2.length - 1), lastMessage];
            });
            break;
          }
        }
      } catch (error2) {
        setError(error2);
      }
    });
    setStatus("awaiting_message");
  };
  return {
    messages,
    input,
    handleInputChange,
    submitMessage,
    status,
    error
  };
}
export {
  useAssistant_experimental,
  useChat,
  useCompletion
};

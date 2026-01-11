// server.js - OpenAI to NVIDIA NIM API Proxy
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// NVIDIA NIM API configuration
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// 🔥 REASONING DISPLAY TOGGLE
const SHOW_REASONING = false;

// 🔥 THINKING MODE TOGGLE
const ENABLE_THINKING_MODE = false;

// 🔧 Strip hidden / inline reasoning for Janitor compatibility
function stripReasoning(content = '') {
  return content
    .replace(/<\s*(thinking|analysis|reasoning)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/^[\s\S]*?(Final Answer:|Answer:)/i, '')
    .trim();
}

// Model mapping
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'gpt-4': 'qwen/qwen3-coder-480b-a35b-instruct',
  'gpt-4-turbo': 'moonshotai/kimi-k2-instruct-0905',
  'gpt-4o': 'deepseek-ai/deepseek-v3.1',
  'claude-3-opus': 'openai/gpt-oss-120b',
  'claude-3-sonnet': 'openai/gpt-oss-20b',
  'gemini-pro': 'qwen/qwen3-next-80b-a3b-thinking'
};

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI to NVIDIA NIM Proxy',
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE
  });
});

// Models endpoint
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy'
  }));

  res.json({ object: 'list', data: models });
});

// Chat completions
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;

    let nimModel = MODEL_MAPPING[model];

    if (!nimModel) {
      const modelLower = model.toLowerCase();
      if (modelLower.includes('gpt-4') || modelLower.includes('claude-opus') || modelLower.includes('405b')) {
        nimModel = 'meta/llama-3.1-405b-instruct';
      } else if (modelLower.includes('claude') || modelLower.includes('gemini') || modelLower.includes('70b')) {
        nimModel = 'meta/llama-3.1-70b-instruct';
      } else {
        nimModel = 'meta/llama-3.1-8b-instruct';
      }
    }

    // 🧠 Reduce reasoning at the source
    const finalMessages = Array.isArray(messages) ? [...messages] : [];
    finalMessages.unshift({
      role: 'system',
      content: 'Respond clearly and concisely. Do not explain your reasoning. Do not include analysis or thinking.'
    });

    const nimRequest = {
      model: nimModel,
      messages: finalMessages,
      temperature: temperature ?? 0.6,
      max_tokens: max_tokens ?? 9024,
      extra_body: ENABLE_THINKING_MODE
        ? { chat_template_kwargs: { thinking: true } }
        : undefined,
      stream: stream || false
    };

    const response = await axios.post(
      `${NIM_API_BASE}/chat/completions`,
      nimRequest,
      {
        headers: {
          'Authorization': `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json'
        },
        responseType: stream ? 'stream' : 'json'
      }
    );

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let buffer = '';

      response.data.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          if (line.includes('[DONE]')) {
            res.write(line + '\n\n');
            continue;
          }

          try {
            const data = JSON.parse(line.slice(6));
            if (data.choices?.[0]?.delta?.content && !SHOW_REASONING) {
              data.choices[0].delta.content = stripReasoning(
                data.choices[0].delta.content
              );
            }
            delete data.choices?.[0]?.delta?.reasoning_content;
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          } catch {
            res.write(line + '\n');
          }
        }
      });

      response.data.on('end', () => res.end());
      response.data.on('error', () => res.end());
    } else {
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: response.data.choices.map(choice => {
          let content = choice.message?.content || '';
          if (!SHOW_REASONING) {
            content = stripReasoning(content);
          }

          return {
            index: choice.index,
            message: {
              role: choice.message.role,
              content
            },
            finish_reason: choice.finish_reason
          };
        }),
        usage: response.data.usage ?? {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };

      res.json(openaiResponse);
    }
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'invalid_request_error',
        code: error.response?.status || 500
      }
    });
  }
});

// Catch-all
app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
  console.log(`Reasoning display: ${SHOW_REASONING ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Thinking mode: ${ENABLE_THINKING_MODE ? 'ENABLED' : 'DISABLED'}`);
});


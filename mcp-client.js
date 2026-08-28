import readline from 'readline';
import fs from 'fs';
import path from 'path';
import dns from 'dns';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import ExcelJS from 'exceljs';
import dotenv from 'dotenv';

dotenv.config();

// 🌐 Force IPv4 First DNS Resolution
dns.setDefaultResultOrder('ipv4first');

// 1. Gemini API Keys & Models Dynamic Hierarchy Configuration
const API_KEYS = [
  process.env.GEMINI_API_KEY_1,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY_4
].filter(Boolean);

// Priority target: gemini-3.6-flash (Removed gemini-2.5-flash to eliminate 404 errors)
export const geminiKeysConfig = API_KEYS.map(key => ({ key, model: 'gemini-3.6-flash' }));

// 2. Groq Fallback Configuration
export const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY || 'DUMMY_KEY',
  baseURL: 'https://api.groq.com/openai/v1'
});
export const GROQ_FALLBACK_MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.6-27b';

// Optimized history size to prevent TPM limit issues (429)
export const MAX_HISTORY_MESSAGES = 4;

// ⚡ Local In-Memory Schema Cache
const SCHEMA_CACHE = new Map();

export function sanitizeArgs(args) {
  if (!args || typeof args !== 'object') return {};
  const sanitized = { ...args };
  for (const key in sanitized) {
    const val = sanitized[key];
    if (typeof val === 'string' && !isNaN(val) && val.trim() !== '') {
      sanitized[key] = Number(val);
    } else if (typeof val === 'object' && val !== null) {
      sanitized[key] = Array.isArray(sanitized[key])
        ? sanitized[key].map(item => (typeof item === 'object' ? sanitizeArgs(item) : item))
        : sanitizeArgs(val);
    }
  }
  return sanitized;
}

export function formatDateValue(val) {
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}/.test(val)) {
    return val.split('T')[0];
  }
  if (val instanceof Date) {
    return val.toISOString().split('T')[0];
  }
  return val;
}

export function sanitizeFilename(text) {
  if (!text || typeof text !== 'string') return 'SAP_Export';
  const clean = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_\-\s]/g, '')
    .trim()
    .replace(/\s+/g, '_');
  return clean.slice(0, 40) || 'SAP_Export';
}

export function getFormattedTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');

  return `${year}-${month}-${day}_${hours}-${minutes}`;
}

export function getOptimizedHistory(history) {
  if (history.length <= MAX_HISTORY_MESSAGES) {
    return history;
  }

  const systemMsg = history.find(m => m.role === 'system');
  const recentHistory = history.slice(-MAX_HISTORY_MESSAGES);

  while (recentHistory.length > 0 && (recentHistory[0].role === 'tool' || recentHistory[0].role === 'function')) {
    recentHistory.shift();
  }

  return systemMsg ? [systemMsg, ...recentHistory] : recentHistory;
}

export function cleanSchemaForGroq(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const clean = {
    type: 'object',
    properties: {}
  };

  if (schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      clean.properties[key] = {
        type: prop.type || 'string',
        description: prop.description || ''
      };
      if (prop.enum) clean.properties[key].enum = prop.enum;
    }
  }

  if (Array.isArray(schema.required)) {
    clean.required = schema.required;
  }

  return clean;
}

export function sanitizeHistoryForGroq(history) {
  return history.map((msg, index) => {
    const cleanMsg = { role: msg.role === 'tool' ? 'tool' : msg.role };

    if (msg.content) {
      cleanMsg.content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    }

    if (msg.role === 'assistant' && msg.tool_calls) {
      cleanMsg.tool_calls = msg.tool_calls.map((tc, idx) => ({
        id: tc.id || `call_groq_${index}_${idx}`,
        type: 'function',
        function: {
          name: tc.function?.name || tc.name,
          arguments: typeof tc.function?.arguments === 'string'
            ? tc.function.arguments
            : JSON.stringify(tc.function?.arguments || tc.args || {})
        }
      }));
    }

    if (msg.role === 'tool') {
      cleanMsg.tool_call_id = msg.tool_call_id || `call_groq_${index}`;
    }

    return cleanMsg;
  });
}

// 📊 Excel Export Function
export async function exportToExcel(outputText, fallbackSummary = '', defaultFilename = 'SAP_Export') {
  try {
    let rows = [];

    const parseContent = (content) => {
      if (!content || typeof content !== 'string') return [];

      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) return parsed;
        if (typeof parsed === 'object' && parsed !== null) return [parsed];
      } catch (e) {}

      const lines = content.split('\n').map(l => l.trim()).filter(l => l.includes('|'));
      if (lines.length >= 3) {
        const headerLine = lines.find(l => l.startsWith('|') && !l.includes('---'));
        if (headerLine) {
          const headers = headerLine.split('|').map(h => h.trim()).filter(h => h !== '');
          const res = [];
          lines.forEach(line => {
            if (line.includes('---') || line === headerLine) return;
            const cells = line.split('|').map(c => c.trim());
            if (cells.length > 0 && cells[0] === '') cells.shift();
            if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
            if (cells.length === headers.length) {
              const rowObj = {};
              headers.forEach((h, idx) => { 
                rowObj[h] = formatDateValue(cells[idx]); 
              });
              res.push(rowObj);
            }
          });
          if (res.length > 0) return res;
        }
      }

      const textLines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      if (textLines.length > 0) {
        return textLines.map((line, index) => ({
          LineNo: index + 1,
          Content: line
        }));
      }

      return [];
    };

    rows = parseContent(outputText);
    if (rows.length === 0 && fallbackSummary) {
      rows = parseContent(fallbackSummary);
    }

    if (!Array.isArray(rows) || rows.length === 0) return null;

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('SAP Result');

    const headers = Object.keys(rows[0]);
    worksheet.columns = headers.map(key => ({
      header: key,
      key: key,
      width: Math.max(key.length + 5, 20)
    }));

    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1F4E78' } };

    rows.forEach(row => worksheet.addRow(row));

    const downloadsDir = path.join(process.cwd(), 'downloads');
    if (!fs.existsSync(downloadsDir)) {
      fs.mkdirSync(downloadsDir, { recursive: true });
    }

    const cleanName = sanitizeFilename(defaultFilename);
    const fileName = `${cleanName}_${getFormattedTimestamp()}.xlsx`;
    const filePath = path.join(downloadsDir, fileName);

    await workbook.xlsx.writeFile(filePath);
    console.log(`📁 Excel file generated automatically: downloads/${fileName}`);
    return fileName;

  } catch (err) {
    console.error('❌ Failed to export Excel:', err.message);
    return null;
  }
}

export function convertToolsToGemini(tools) {
  if (!tools || tools.length === 0) return undefined;
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters
    }))
  }];
}

export async function createAICompletion(history, tools = []) {
  const optimizedHistory = getOptimizedHistory(history);
  const systemMsg = optimizedHistory.find(m => m.role === 'system')?.content || '';

  const geminiContents = [];

  for (const m of optimizedHistory) {
    if (m.role === 'system') continue;

    if (m.role === 'user') {
      geminiContents.push({ role: 'user', parts: [{ text: String(m.content || '') }] });
    } else if (m.role === 'assistant') {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      if (m.tool_calls) {
        m.tool_calls.forEach(tc => {
          parts.push({
            functionCall: {
              name: tc.function?.name || tc.name,
              args: typeof tc.function?.arguments === 'string'
                ? JSON.parse(tc.function.arguments || '{}')
                : (tc.function?.arguments || tc.args || {})
            }
          });
        });
      }
      geminiContents.push({ role: 'model', parts: parts.length > 0 ? parts : [{ text: '' }] });
    } else if (m.role === 'tool') {
      geminiContents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: m.name || 'execute_sql_query',
            response: {
              output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || {})
            }
          }
        }]
      });
    }
  }

  const config = {
    temperature: 0.1,
    tools: convertToolsToGemini(tools)
  };
  if (systemMsg) config.systemInstruction = systemMsg;

  for (let i = 0; i < geminiKeysConfig.length; i++) {
    const { key: currentKey, model: currentModel } = geminiKeysConfig[i];
    const targetModel = currentModel || 'gemini-3.6-flash';
    try {
      console.log(`🧠 Querying Gemini API [${targetModel}] (Key #${(i % API_KEYS.length) + 1})...`);
      const ai = new GoogleGenAI({ apiKey: currentKey });

      const response = await ai.models.generateContent({
        model: targetModel,
        contents: geminiContents,
        config: config
      });

      const candidate = response.candidates?.[0];
      const rawParts = candidate?.content?.parts || [];
      const functionCalls = rawParts.filter(p => p.functionCall).map(p => p.functionCall);

      if (functionCalls && functionCalls.length > 0) {
        return {
          message: {
            role: 'assistant',
            tool_calls: rawParts.filter(p => p.functionCall).map((p, idx) => ({
              id: `call_gemini_${Date.now()}_${idx}`,
              type: 'function',
              function: {
                name: p.functionCall.name,
                arguments: JSON.stringify(p.functionCall.args || {})
              }
            }))
          }
        };
      }

      return {
        message: {
          role: 'assistant',
          content: response.text || ''
        }
      };

    } catch (err) {
      console.warn(`⚠️ Gemini API Issue on [${targetModel}] Key #${(i % API_KEYS.length) + 1}: ${err.message || err.status}`);
      if (i < geminiKeysConfig.length - 1) {
        console.log(`🔄 Switching to next available Gemini Key/Model configuration...`);
      }
    }
  }

  console.warn(`\n⚠️ All Gemini Keys & Models failed! Switching automatically to Groq Fallback: [${GROQ_FALLBACK_MODEL}]...\n`);

  try {
    const sanitizedGroqHistory = sanitizeHistoryForGroq(optimizedHistory);

    const groqTools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.function.name,
        description: t.function.description || `Execute ${t.function.name}`,
        parameters: cleanSchemaForGroq(t.function.parameters)
      }
    }));

    const groqResponse = await groq.chat.completions.create({
      model: GROQ_FALLBACK_MODEL,
      messages: sanitizedGroqHistory,
      tools: groqTools.length > 0 ? groqTools : undefined,
      tool_choice: groqTools.length > 0 ? 'auto' : undefined,
      temperature: 0.1
    });

    return { message: groqResponse.choices[0].message };
  } catch (groqErr) {
    console.error('❌ Both Gemini Keys and Groq failed:', groqErr.message);
    throw groqErr;
  }
}

// 🛡️ Fast Conditional Guard via Gemini API
export async function validateSQLIntent(userQuery, generatedSQL) {
  const isComplexQuery = /JOIN|FROM\s+\w+\s*,\s*\w+/i.test(generatedSQL);
  if (!isComplexQuery) {
    console.log('⚡ Simple SQL Query detected. Skipping AI Guard to save Tokens.');
    return { valid: true, reason: 'Simple Query - Guard Skipped' };
  }

  const validationPrompt = `
You are a Database Validator for SAP Business One MSSQL queries.
Verify if the SQL query correctly matches the user request intent:

User Prompt: "${userQuery}"
Generated SQL: "${generatedSQL}"

Rules to Check:
1. Sales vs Purchasing Check:
   - Sales documents (Sales Order, Sales Delivery, A/R Invoice) MUST target Customer tables (ORDR, ODLN, OINV) and CardType='C'.
   - Purchasing documents (Purchase Order, Goods Receipt PO, A/P Invoice) MUST target Vendor tables (OPOR, OPDN, OPCH) and CardType='S'.
2. Incoming Payments Check:
   - Header table 'ORCT' MUST join 'RCT2' via ORCT.DocEntry = RCT2.DocNum.
   - Invoice link: Join RCT2 to OINV via RCT2.DocEntry = OINV.DocEntry AND RCT2.InvType = 13.
3. Spelling Checks:
   - Item Description field: MUST be 'Dscription' (NOT 'Description').
   - Gross Profit field: MUST be 'GrssProfit' (NOT 'GrssProfil').

Response format: Return JSON ONLY in this format:
{"valid": true, "reason": "OK"} OR {"valid": false, "reason": "Explanation...", "suggestedFix": "Correct SQL"}
`;

  const FAST_GUARD_MODEL = 'gemini-3.6-flash';

  for (let i = 0; i < geminiKeysConfig.length; i++) {
    const { key: currentKey } = geminiKeysConfig[i];
    try {
      const ai = new GoogleGenAI({ apiKey: currentKey });
      const response = await ai.models.generateContent({
        model: FAST_GUARD_MODEL,
        contents: [{ role: 'user', parts: [{ text: validationPrompt }] }],
        config: { temperature: 0.0 }
      });

      const jsonMatch = (response.text || '').match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.warn(`⚠️ Fast Guard Failed on Key #${(i % API_KEYS.length) + 1} (${e.message}). Rotating...`);
    }
  }

  try {
    const groqResponse = await groq.chat.completions.create({
      model: GROQ_FALLBACK_MODEL,
      messages: [{ role: 'user', content: validationPrompt }],
      temperature: 0.0
    });
    const jsonMatch = (groqResponse.choices[0].message.content || '').match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { valid: true, reason: 'Guard parsing bypassed' };
  } catch (e) {
    console.warn('⚠️ Fast Guard skipped due to all API keys failing.');
    return { valid: true, reason: 'Validation Skipped due to Provider Failures' };
  }
}

export async function executeToolCall(client, history, name, rawArgs, callId = null, interactiveMode = true) {
  const cleanArgs = sanitizeArgs(rawArgs);

  if (name === 'get_table_schema' || name === 'search_sap_metadata') {
    const tableName = (cleanArgs.tableName || cleanArgs.table || cleanArgs.query || '').toUpperCase();
    if (tableName && SCHEMA_CACHE.has(tableName)) {
      console.log(`⚡ [Cache Hit] Returning schema for table [${tableName}] directly from local cache (0 Tokens spent).`);
      const cachedSchemaText = SCHEMA_CACHE.get(tableName);

      history.push({
        role: 'tool',
        name: name,
        tool_call_id: callId || `call_${Date.now()}`,
        content: cachedSchemaText
      });

      return {
        outputText: cachedSchemaText,
        fullSummary: cachedSchemaText,
        isSqlOrDataTool: false,
        excelUrl: null
      };
    }
  }

  console.log(`\n⚙️ Executing SAP Tool [${name}] with args:`, JSON.stringify(cleanArgs));

  try {
    const toolResult = await client.callTool({ name, arguments: cleanArgs });
    const outputText = toolResult.content.map(c => c.text).join('\n');

    if (name === 'get_table_schema' || name === 'search_sap_metadata') {
      const tableName = (cleanArgs.tableName || cleanArgs.table || cleanArgs.query || '').toUpperCase();
      if (tableName) {
        SCHEMA_CACHE.set(tableName, outputText);
        console.log(`⚡ [Cache Saved] Cached schema for table [${tableName}].`);
      }
    }

    console.log(`📊 SAP Raw Data Response Received (${outputText.length} chars).`);

    const isSqlOrDataTool = name.includes('sql') || name.includes('data') || name.includes('products') || name === 'get_table_schema';

    let excelUrl = null;

    if (isSqlOrDataTool && outputText.trim().length > 0) {
      const exportName = cleanArgs.tableName || cleanArgs.table || name;
      const generatedFile = await exportToExcel(outputText, '', exportName);
      if (generatedFile) {
        excelUrl = `/downloads/${generatedFile}`;
        console.log(`📁 Excel generated and attached to Result: ${excelUrl}`);
      }
    }

    const MAX_CHAR_LIMIT = 1500;
    const safeOutputText = outputText.length > MAX_CHAR_LIMIT
      ? outputText.slice(0, MAX_CHAR_LIMIT) + '\n\n⚠️ [Data Truncated for AI context limits. Full data exported to Excel.]'
      : outputText;

    history.push({
      role: 'tool',
      name: name,
      tool_call_id: callId || `call_${Date.now()}`,
      content: safeOutputText
    });

    let fullSummary = safeOutputText;

    if (!isSqlOrDataTool) {
      console.log('🧠 Summarizing result with AI...');
      try {
        const summaryResponse = await createAICompletion(history);
        fullSummary = summaryResponse.message.content || safeOutputText;
      } catch (aiErr) {
        console.warn('⚠️ AI Summarization failed on all providers! Returning raw SAP response directly.');
        fullSummary = safeOutputText;
      }
    } else {
      console.log('⚡ Data / Schema result detected. Bypassing AI Summarization to conserve API quota.');
    }

    return {
      outputText,
      fullSummary,
      isSqlOrDataTool,
      excelUrl
    };

  } catch (err) {
    console.error(`❌ Error executing tool ${name}:`, err.message);
    throw err;
  }
}

// 🚀 Local Terminal Main Entry Point
async function main() {
  console.log('🚀 Starting Autonomous SAP MCP Client...');

  if (geminiKeysConfig.length === 0) {
    console.error('❌ Missing Gemini API Keys in process.env. Please check your .env file.');
    process.exit(1);
  }

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['src/index.js']
  });

  const client = new Client({ name: "sap-cli-client", version: "3.5.0" }, { capabilities: {} });
  await client.connect(transport);
  console.log('✅ Connected to SAP MCP Server');

  const toolsResult = await client.listTools();

  const formattedTools = toolsResult.tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || `Execute ${tool.name}`,
      parameters: tool.inputSchema
    }
  }));

  console.log(`📋 Loaded Tools: ${toolsResult.tools.map(t => t.name).join(', ')}`);
  console.log(`\n💬 AI System Ready! Autonomous Reasoning & Self-Correction Engine Enabled.\n`);

  const history = [
    {
      role: 'system',
      content: `You are an Autonomous SAP Business One AI Data Architect (MSSQL Database).

Your primary goal is to accurately translate ANY user request into precise SQL, execute it, verify results, and deliver 100% accurate data.

MANDATORY 4-STEP REASONING WORKFLOW:

1. SCHEMA INSPECTION:
   - Call 'get_table_schema' or 'search_sap_metadata' for tables involved before writing complex SQL unless already present in context.

2. SAP B1 CORE RELATIONSHIPS & COLUMNS:
   - Documents Header to Line tables join on 'DocEntry'.
   - PRODUCTION ORDERS (OWOR): Always exclude canceled production orders using 'Status <> \'C\'' or 'Status != \'C\''.
   - INVENTORY TRANSACTIONS (OINM): Always use 'LocCode' (NOT 'WhsCode') when joining OINM with OITW (e.g. OINM.LocCode = OITW.WhsCode).
   - Incoming Payments: ORCT T0 INNER JOIN RCT2 T1 ON T0.DocEntry = T1.DocNum. For Sales Invoices link: T1.InvType = 13 AND INNER JOIN OINV T2 ON T1.DocEntry = T2.DocEntry.
   - Payment Methods (Mode de Paiement): Use CASE WHEN T0.CashSum > 0 THEN 'Espèce' WHEN T0.CheckSum > 0 THEN 'Chèque' WHEN T0.TrsfrSum > 0 THEN 'Virement' ELSE 'Autre' END AS Mode_Paiement.
   - For standard sales/purchase documents, exclude canceled entries: T0.Canceled = 'N'.

3. SQL EXECUTION & DRY RUN:
   - Execute MSSQL queries via 'execute_sql_query'. Always cast dates: CAST(T0.DocDate AS DATE).

4. SELF-CORRECTION & REFLECTION LOOP:
   - If SQL returns an error or 0 rows, evaluate table names/joins, fix logic autonomously, and retry up to 3 times before finalizing response.

STRICT OUTPUT:
- Return results as clean Markdown Tables (| Col1 | Col2 |).
- Zero conversational setup fluff before structured tables.`
    }
  ];
  let lastUserQuery = 'SAP_QueryResult';

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const askQuestion = (queryText) => new Promise(resolve => rl.question(queryText, resolve));

  const promptUser = async () => {
    const query = (await askQuestion('You: ')).trim();

    if (['quit', 'exit'].includes(query.toLowerCase())) {
      rl.close();
      process.exit(0);
    }
    if (!query) return promptUser();

    lastUserQuery = query;
    history.push({ role: 'user', content: query });

    try {
      let currentResponse = await createAICompletion(history, formattedTools);
      let message = currentResponse.message;

      while (message.tool_calls && message.tool_calls.length > 0) {
        history.push(message);

        for (const call of message.tool_calls) {
          let parsedArgs = typeof call.function.arguments === 'string'
            ? JSON.parse(call.function.arguments || '{}')
            : call.function.arguments;

          if (call.function.name === 'execute_sql_query' && parsedArgs.query) {
            console.log('🛡️ Running Fast Conditional AI Guard...');
            const validation = await validateSQLIntent(lastUserQuery, parsedArgs.query);

            if (!validation.valid) {
              console.warn(`⚠️ Smart Guard Corrected Query: ${validation.reason}`);
              if (validation.suggestedFix) {
                parsedArgs.query = validation.suggestedFix;
              }
            } else {
              console.log(`✅ Smart Guard Check Passed (${validation.reason}).`);
            }
          }

          const toolExecResult = await executeToolCall(client, history, call.function.name, parsedArgs, call.id, true);
          
          if (toolExecResult.outputText.includes('Error') || toolExecResult.outputText.includes('mssql')) {
            console.warn('⚠️ SQL Error detected! AI will self-reflect and retry...');
          }
          console.log(`\n🤖 Tool [${call.function.name}] Executed successfully.\n`);
        }

        // ⏱️ Delay added between tool call turns to avoid 429 RPM limits
        await new Promise(resolve => setTimeout(resolve, 2500));

        console.log('🔄 Continuing AI execution loop...');
        currentResponse = await createAICompletion(history, formattedTools);
        message = currentResponse.message;
      }

      history.push(message);

      if (message.content) {
        console.log(`\n🤖 AI Response:\n${message.content}\n`);
      }
    } catch (err) {
      console.error('❌ AI API Error:', err.message);
    }

    promptUser();
  };

  promptUser();
}

if (process.argv[1] && process.argv[1].endsWith('mcp-client.js')) {
  main().catch(console.error);
}
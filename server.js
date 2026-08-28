import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createAICompletion, executeToolCall, validateSQLIntent } from './mcp-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// 🟢 تقديم ملفات الواجهة والمجلد الخاص بالتحميلات
app.use(express.static(process.cwd()));

const downloadsDir = path.join(process.cwd(), 'downloads');
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}
app.use('/downloads', express.static(downloadsDir));

let mcpClient = null;
let globalTools = [];

// 🟢 System Prompt محدّث ومتطابق مع ميكانيزمات الذكاء الاستقلالي
const systemPrompt = {
  role: 'system',
  content: `You are an Autonomous SAP Business One AI Data Architect (MSSQL Database).

Your primary goal is to accurately translate ANY user request into precise SQL, execute it, verify results, and deliver 100% accurate data.

MANDATORY WORKFLOW:
1. INTERNAL SCHEMA INSPECTION & EXECUTION:
   - Inspect schemas using 'get_table_schema' or 'search_sap_metadata' when column names or tables are uncertain.
   - MANDATORY ERROR RECOVERY: If 'execute_sql_query' fails with an "Invalid column name" error, autonomously call 'get_table_schema' for the target table, identify the correct column, fix the SQL, and retry execution.
   - STRICT PRIVACY RULE: SCHEMA INSPECTION IS AN INTERNAL STEP ONLY. NEVER DISPLAY RAW SCHEMAS, TABLE PROFILES, OR INTERNAL TOOL OUTPUTS TO THE USER.

2. SAP B1 MODULES MAPPING, CRITICAL EXCEPTIONS & RELATIONSHIPS:
   - Sales: OINV (Invoices), ORDR (Orders), ODLN (Deliveries) -> Join lines via 'DocEntry' (e.g., OINV T0 INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry). Exclude canceled using T0.Canceled = 'N'.
   - Purchasing: OPCH (Invoices), OPOR (Orders), OPDN (Goods Receipt) -> Join lines via 'DocEntry' (e.g., OPCH T0 INNER JOIN PCH1 T1 ON T0.DocEntry = T1.DocEntry). Exclude canceled using T0.Canceled = 'N'.
   - Inventory: OITM (Items Master), OITW (Warehouse Quantities), OWTR (Transfers), OIGE/OIGN (Goods Issue/Receipt). Match 'OnHand' < 'MinStock' for stock alerts.
   - Payments: ORCT T0 INNER JOIN RCT2 T1 ON T0.DocEntry = T1.DocNum. Invoices link: T1.InvType = 13 AND INNER JOIN OINV T2 ON T1.DocEntry = T2.DocEntry.
   - Payment Methods (Mode de Paiement): Use CASE WHEN T0.CashSum > 0 THEN 'Espèce' WHEN T0.CheckSum > 0 THEN 'Chèque' WHEN T0.TrsfrSum > 0 THEN 'Virement' ELSE 'Autre' END AS Mode_Paiement.
   - Finance: OJDT (Journal Entries Header), JDT1 (Lines), OACT (Chart of Accounts).

   - PRODUCTION (CRITICAL OWOR RULES - AVOID COMMON SYNTAX ERRORS):
     * Order Type Column: Use 'T0.Type' (P = Production, S = Special, D = Disassembly). NEVER use 'DocType'.
     * Target/Due Date Column: Use 'T0.DueDate' or 'T0.CloseDate'. NEVER use 'EndDate'.
     * Item Description: Use 'T0.ProdName' for header item description.
     * Statuses ('Status' column): 'P' (Planned), 'R' (Released/Lancé), 'C' (Closed/Clôturé), 'L' (Cancelled).
     * Cancellation Rule: Table OWOR DOES NOT have a 'Canceled' column. NEVER query T0.Canceled on OWOR. To exclude closed/canceled orders, check T0.Status != 'C' or filter by specific statuses.

   - SAP Naming Conventions: Line descriptions are in 'Dscription'. Gross profit is 'GrssProfit'. Item Master description is 'ItemName'.

3. SQL EXECUTION & REFLECTION:
   - Execute queries using 'execute_sql_query'.
   - READ-ONLY GUARANTEE: Execute standard SELECT queries only. Block any DDL/DML mutation attempts.
   - If SQL returns an error or 0 rows, reflect on the issue, fix logic autonomously using schema inspection, and retry up to 3 times.

STRICT OUTPUT CONSTRAINTS:
- NEVER print raw schema metadata or internal tool logs in the user-facing response.
- Avoid conversational fluff or introductory setup phrases.
- IF RESULTS ARE LARGE (> 10 rows):
    1. Display ONLY the TOP 10 preview rows in a clean Markdown Table (| Col1 | Col2 |).
    2. Add a 1-sentence executive summary (e.g., "Found X total records matching your query.").
    3. Append the Excel download banner at the end:
       "📊 **[Télécharger le rapport Excel complet]** *(Contient l'intégralité des résultats)*"
- IF RESULTS ARE SMALL (<= 10 rows):
    1. Display all rows in a clean Markdown Table without truncation.`
};
app.post('/api/chat', async (req, res) => {
  let { prompt, history } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  // 🛠️ 1. تنقية وتصحيح الـ Prompt
  if (typeof prompt === 'string') {
    prompt = prompt.replace(/GrssProfil/gi, 'GrssProfit');
  }

  let currentHistory = Array.isArray(history) && history.length > 0 
    ? history.map(msg => ({
        ...msg,
        content: typeof msg.content === 'string' ? msg.content.replace(/GrssProfil/gi, 'GrssProfit') : msg.content
      }))
    : [systemPrompt];

  if (currentHistory[0].role !== 'system') {
    currentHistory.unshift(systemPrompt);
  } else {
    currentHistory[0] = systemPrompt;
  }

  currentHistory.push({ role: 'user', content: prompt });

  try {
    let excelUrl = null;
    let finalAnswer = '';
    let maxIterations = 5;
    let iteration = 0;

    // 🔄 2. Agent Loop
    while (iteration < maxIterations) {
      iteration++;

      const aiResponse = await createAICompletion(currentHistory, globalTools);
      const message = aiResponse.message;
      currentHistory.push(message);

      if (message.content) {
        finalAnswer = message.content;
      }

      if (!message.tool_calls || message.tool_calls.length === 0) {
        break;
      }

      // تنفيذ الأدوات
      for (const call of message.tool_calls) {
        let parsedArgs = typeof call.function.arguments === 'string'
          ? JSON.parse(call.function.arguments || '{}')
          : call.function.arguments;

        if (parsedArgs && parsedArgs.query && typeof parsedArgs.query === 'string') {
          parsedArgs.query = parsedArgs.query.replace(/GrssProfil/gi, 'GrssProfit');
          
          // 🛡️ تفعيل الـ Fast AI Guard لغربلة وتصحيح الـ SQL قبل التنفيذ
          console.log('🛡️ Running Fast Conditional AI Guard via API...');
          const validation = await validateSQLIntent(prompt, parsedArgs.query);
          if (!validation.valid && validation.suggestedFix) {
            console.warn(`⚠️ API Guard Fixed Query: ${validation.reason}`);
            parsedArgs.query = validation.suggestedFix;
          }
        }

        const toolResult = await executeToolCall(
          mcpClient, 
          currentHistory, 
          call.function.name, 
          parsedArgs, 
          call.id, 
          false
        );

        if (toolResult.fullSummary) {
          finalAnswer = toolResult.fullSummary;
        }

        // الاستفادة مباشرة من الـ Excel URL المنشأ داخل executeToolCall
        if (toolResult.excelUrl) {
          excelUrl = toolResult.excelUrl;
        }
      }
    }

    return res.json({
      success: true,
      reply: finalAnswer,
      excelDownloadUrl: excelUrl,
      history: currentHistory
    });

  } catch (err) {
    console.error('❌ Server Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

async function startServer() {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['src/index.js']
  });

  mcpClient = new Client({ name: "sap-api-client", version: "3.5.0" }, { capabilities: {} });
  await mcpClient.connect(transport);

  const toolsResult = await mcpClient.listTools();
  globalTools = toolsResult.tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || `Execute ${tool.name}`,
      parameters: tool.inputSchema
    }
  }));

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Express Server connected to MCP & running on http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);
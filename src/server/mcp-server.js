import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

export class SAPMCPServer {
  constructor(sapService, sqlService = null) {
    this.sapService = sapService;
    this.sqlService = sqlService; // SQL Direct Connection (Optional Hybrid Mode)
    this.server = new McpServer({ name: 'sap-b1-mcp-server', version: '2.1.0' });
    this.registerTools();
  }

  registerTools() {
    // ------------------------------------------------------------------
    // 1. Health Check Tool
    // ------------------------------------------------------------------
    this.server.tool('sap_health_check', {}, async () => {
      const slHealth = await this.sapService.healthCheck();
      let sqlStatus = 'Not Configured';

      if (this.sqlService) {
        try {
          const isSqlOk = await this.sqlService.healthCheck();
          sqlStatus = isSqlOk ? 'Connected (SQL Server 2016)' : 'Disconnected';
        } catch (e) {
          sqlStatus = `Error: ${e.message}`;
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: `SAP Service Layer: ${slHealth.status} (${slHealth.message})\nSQL Direct Read Access: ${sqlStatus}`
          }
        ]
      };
    });

    // ------------------------------------------------------------------
    // 2. Schema Discovery Tool (Secured)
    // ------------------------------------------------------------------
    this.server.tool(
      'get_table_schema',
      {
        tableName: z.string().regex(/^[a-zA-Z0-9_@]+$/).describe('The name of the SAP table to inspect (e.g., OWOR, WOR1, OHEM, OCRD, OITM, OINV, ORDR)')
      },
      async ({ tableName }) => {
        if (!this.sqlService) {
          return { content: [{ type: 'text', text: '❌ Direct SQL execution is not configured for schema discovery.' }] };
        }

        try {
          const sanitizedTable = tableName.replace(/[^a-zA-Z0-9_@]/g, '');
          const query = `
            SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = '${sanitizedTable}'
          `;
          const columns = await this.sqlService.query(query);

          if (!columns || columns.length === 0) {
            return { content: [{ type: 'text', text: `⚠️ Table [${sanitizedTable}] not found or has no columns.` }] };
          }

          const formattedSchema = columns
            .map(c => `• ${c.COLUMN_NAME} (${c.DATA_TYPE}${c.CHARACTER_MAXIMUM_LENGTH ? `, max len: ${c.CHARACTER_MAXIMUM_LENGTH}` : ''})`)
            .join('\n');

          return {
            content: [
              {
                type: 'text',
                text: `📋 Schema for Table [${sanitizedTable}]:\n${formattedSchema}`
              }
            ]
          };
        } catch (err) {
          return { content: [{ type: 'text', text: `❌ Error fetching schema: ${err.message}` }] };
        }
      }
    );

    // ------------------------------------------------------------------
    // 3. Get Products Tool
    // ------------------------------------------------------------------
    this.server.tool(
      'get_products',
      {
        limit: z.number().default(10),
        skip: z.number().default(0),
        search: z.string().optional()
      },
      async ({ limit, skip, search }) => {
        if (this.sqlService) {
          try {
            let query = `SELECT TOP ${limit} ItemCode, ItemName, OnHand AS QuantityOnStock FROM OITM`;
            let conditions = [];

            if (search) {
              const cleanSearch = search.replace(/'/g, "''");
              conditions.push(`(ItemCode LIKE '%${cleanSearch}%' OR ItemName LIKE '%${cleanSearch}%')`);
            }

            if (skip > 0) {
              query = `SELECT ItemCode, ItemName, OnHand AS QuantityOnStock FROM OITM`;
              if (conditions.length > 0) query += ` WHERE ${conditions.join(' AND ')}`;
              query += ` ORDER BY ItemCode OFFSET ${skip} ROWS FETCH NEXT ${limit} ROWS ONLY`;
            } else if (conditions.length > 0) {
              query += ` WHERE ${conditions.join(' AND ')}`;
            }

            const items = await this.sqlService.query(query);
            const formatted = items.map(i => `• ${i.ItemCode} - ${i.ItemName} (Stock: ${i.QuantityOnStock})`).join('\n');
            return { content: [{ type: 'text', text: formatted || 'No products found via Direct SQL.' }] };
          } catch (sqlErr) {
            console.warn('SQL Read failed, falling back to Service Layer:', sqlErr.message);
          }
        }

        const data = await this.sapService.getProducts(limit, skip, search);
        const items = data.value || [];
        const formatted = items.map(i => `• ${i.ItemCode} - ${i.ItemName} (Stock: ${i.QuantityOnStock})`).join('\n');
        return { content: [{ type: 'text', text: formatted || 'No products found.' }] };
      }
    );

    // ------------------------------------------------------------------
    // 4. Create Sales Order Tool
    // ------------------------------------------------------------------
    this.server.tool(
      'create_sales_order',
      {
        cardCode: z.string(),
        docDueDate: z.string().optional(),
        items: z.array(z.object({
          itemCode: z.string(),
          quantity: z.number().positive(),
          price: z.number().optional()
        }))
      },
      async ({ cardCode, docDueDate, items }) => {
        const res = await this.sapService.createSalesOrder(cardCode, docDueDate, items);
        return { content: [{ type: 'text', text: `✅ Sales Order #${res.DocNum} Created! Total: ${res.DocTotal} ${res.DocCurrency}` }] };
      }
    );

    // ------------------------------------------------------------------
    // 5. Dynamic Table Data Fetcher Tool (Secured Filter)
    // ------------------------------------------------------------------
    this.server.tool(
      'get_sap_table_data',
      {
        tableName: z.string().regex(/^[a-zA-Z0-9_@]+$/).describe('Name of the SAP table or UDT (e.g. OWOR, WOR1, OITM, OCRD, OINV, ORDR, OWHS, @MY_TABLE)'),
        limit: z.number().default(5),
        skip: z.number().default(0),
        filter: z.string().optional()
      },
      async ({ tableName, limit, skip, filter }) => {
        try {
          if (this.sqlService) {
            const sanitizedTable = tableName.replace(/[^a-zA-Z0-9_@]/g, '');
            let sqlQuery = `SELECT TOP ${limit} * FROM [${sanitizedTable}]`;
            
            if (filter) {
              // Strict Filter Check to prevent injections
              const forbiddenKeywords = [/DROP/i, /DELETE/i, /UPDATE/i, /INSERT/i, /EXEC/i, /;/];
              if (forbiddenKeywords.some(regex => regex.test(filter))) {
                throw new Error("Potential malicious SQL detected in filter parameter.");
              }
              sqlQuery += ` WHERE ${filter}`;
            }

            const data = await this.sqlService.query(sqlQuery);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
          }

          const res = await this.sapService.getTableData(tableName, limit, skip, filter);
          const items = res.value || res;
          return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `❌ Error fetching table ${tableName}: ${err.message}` }] };
        }
      }
    );

    // ------------------------------------------------------------------
    // 6. Direct Custom T-SQL Execution Tool (Full Uncut Result + READ-ONLY Guard)
    // ------------------------------------------------------------------
    this.server.tool(
      'execute_sql_query',
      {
        query: z.string().describe(`
Execute raw READ-ONLY T-SQL SELECT queries on SAP Business One database.

CRITICAL T-SQL SYNTAX RULES:
1. Provide RAW T-SQL ONLY (e.g. "SELECT T0.DocNum, T0.PostDate FROM OWOR T0").
2. DO NOT write "EXEC", "EXECUTE", or wrap inside procedure calls.
3. ALWAYS format dates as standard ISO literals: 'YYYY-MM-DD' (e.g., PostDate BETWEEN '2022-06-01' AND '2022-06-15'). NEVER use DD/MM/YYYY.

CRITICAL SAP BUSINESS ONE PRODUCTION MAPPINGS:
- PRODUCTION ORDERS (Header level):
  * Table: OWOR (DocNum, PostDate, ItemCode, ProdName, CmpltQty, PlannedQty, Status)
  * ProdName = Finished Product Description.
  * CmpltQty = Completed Quantity.
  * DO NOT JOIN WOR1 unless explicit component-level breakdown is requested!
- PRODUCTION COMPONENTS/LINES:
  * Table: WOR1 (DocEntry, LineNum, ItemCode, Dscription, PlannedQty, IssuedQty)
- SALES ORDERS: ORDR (Header), RDR1 (Rows)
- SALES INVOICES: OINV (Header), INV1 (Rows)
- EMPLOYEES: OHEM (empID, firstName, lastName, jobTitle, dept)
- BUSINESS PARTNERS: OCRD (CardCode, CardName, CardType)
- PRODUCTS: OITM (ItemCode, ItemName, OnHand, Price)
        `.trim())
      },
      async ({ query }) => {
        if (!this.sqlService) {
          return { content: [{ type: 'text', text: '❌ Direct SQL execution is not configured on this server.' }] };
        }

        try {
          const cleanQuery = query.trim();

          // 1. الحظر الفعلي: التأكد أن الاستعلام يبدأ بـ SELECT حصراً
          if (!/^SELECT\s+/i.test(cleanQuery)) {
            return { content: [{ type: 'text', text: '❌ Security Error: Only SELECT queries are permitted.' }] };
          }

          // 2. الحظر الفعلي: منع أي عمليات تعديل أو كتابة
          const forbidden = /\b(ALTER|CREATE|DELETE|DROP|EXEC|EXECUTE|INSERT|MERGE|TRUNCATE|UPDATE|GRANT|REVOKE)\b/i;
          if (forbidden.test(cleanQuery)) {
            return { content: [{ type: 'text', text: '❌ Security Error: Mutation and Execution statements are forbidden.' }] };
          }

          // 3. منع تنفيذ استعلامات متعددة مفصولة بـ ;
          if (cleanQuery.includes(';')) {
            return { content: [{ type: 'text', text: '❌ Security Error: Multiple queries separated by ";" are not allowed.' }] };
          }

          // تنفيذ الاستعلام وإرجاع النتيجة كاملة بدون اقتطاع
          const results = await this.sqlService.query(cleanQuery);
          return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `❌ SQL Execution Error: ${err.message}` }] };
        }
      }
    );
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}
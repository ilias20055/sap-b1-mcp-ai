# 🚀 SAP Business One - MCP AI Assistant

An intelligent, full-stack Natural Language interface for **SAP Business One (MSSQL)** built on top of the **Model Context Protocol (MCP)**. 

This project bridges Large Language Models (LLMs) with SAP B1 SQL databases, allowing users to query business data using natural language (English, French, Arabic, Darija), inspect metadata, automatically handle schema errors, and export structured results directly to formatted Excel reports.

---

## ✨ Features & Enhancements

* **🤖 Advanced AI Resilience & Multi-Key Rotation**:
  * **Primary Engine**: Multi-Key sequential rotation supporting up to 4+ Gemini API keys (`gemini-3.6-flash`).
  * **Fallback Engine**: Automatic seamless failover to Groq (`qwen/qwen3.6-27b` / `llama-3.3-70b-versatile`) if Gemini keys hit daily rate limits (`429 Resource Exhausted`).
* **🛡️ Self-Healing SAP B1 Schema Guardrails**:
  * **Autonomous Schema Recovery**: Auto-triggers `get_table_schema` lookup when encountering SQL column errors (`Invalid column name`), repairs queries, and retries automatically.
  * **Production Module Rules (`OWOR`)**: Hardcoded system prompt guards preventing hallucinated column names (e.g., enforces `Type` instead of `DocType`, `DueDate` instead of `EndDate`, and handles cancellation via `Status` without invalid `Canceled` column joins).
* **⚡ Robust History & Payload Sanitization**:
  * **Sequence Safety**: Cleans up orphaned function call turns to prevent `400 INVALID_ARGUMENT` API sequence breaks.
  * **Token Usage Optimization**: Auto-truncates large tool schemas during fallback requests to prevent hitting Groq TPM (Tokens Per Minute) caps.
* **📊 Automatic Excel Spreadsheet Generation**:
  * Converts structured SQL tool outputs directly into downloadable `.xlsx` files using `ExcelJS`.
* **🌐 Dual Execution Modes**:
  * **CLI Mode**: Standalone interactive terminal interface (`mcp-client.js`).
  * **Web UI**: Modern Express-backed Web Interface featuring a dark-mode, Gemini-style chat canvas (`server.js`).

---

## 🏗️ Architecture Overview

```text
  ┌────────────────┐     ┌────────────────┐
  │   Web UI /     │ ──► │ Express Server │ ──┐
  │   Terminal     │     │  (server.js)   │   │
  └────────────────┘     └────────────────┘   │
                                              ▼
                                   ┌──────────────────┐
                                   │  mcp-client.js   │
                                   └────────┬─────────┘
                                            │
               ┌────────────────────────────┴────────────────────────────┐
               ▼                                                         ▼
    ┌────────────────────┐                                   ┌────────────────────┐
    │  AI Orchestration  │                                   │     MCP Server     │
    │  (Gemini ➔ Groq)   │                                   │   (src/index.js)   │
    └────────────────────┘                                   └─────────┬──────────┘
                                                                       ▼
                                                             ┌────────────────────┐
                                                             │ SAP B1 SQL Database│
                                                             └────────────────────┘
```
📦 Prerequisites
Node.js: v18+

Database: Microsoft SQL Server hosting SAP Business One database.

API Keys:

At least 1 (preferably 3-4) Google Gemini API Keys.

1 Groq API Key (recommended for emergency fallback).

⚙️ Installation & Setup
1. Clone the Repository
```bash
git clone [https://github.com/YOUR_USERNAME/YOUR_REPOSITORY_NAME.git](https://github.com/YOUR_USERNAME/YOUR_REPOSITORY_NAME.git)
cd YOUR_REPOSITORY_NAME
```
2. Install Dependencies
```bash
git clone [https://github.com/YOUR_USERNAME/YOUR_REPOSITORY_NAME.git](https://github.com/YOUR_USERNAME/YOUR_REPOSITORY_NAME.git)
cd YOUR_REPOSITORY_NAME
```
3. Environment Configuration
Create a .env file in the root directory and configure your credentials:
```bash
git clone [https://github.com/YOUR_USERNAME/YOUR_REPOSITORY_NAME.git](https://github.com/YOUR_USERNAME/YOUR_REPOSITORY_NAME.git)
cd YOUR_REPOSITORY_NAME
```
🚀 Running the Project
Option A: Web Interface (Recommended)
Launch the Express backend server with the embedded Gemini-style UI:

```bash
node server.js
```
Open your browser and navigate to: http://localhost:3000

Option B: Terminal CLI Mode
Run the standalone interactive command-line interface:
```bash
node mcp-client.js
```

🛠️ Usage Examples
You can interact with the assistant using standard natural language queries in French, Arabic, English, or Darija:

```bash
Sales & Invoicing:

"Affiche-moi la liste des 5 derniers documents dans OINV"

Production Orders (OWOR):

"Give me all released production orders for year 2022 sorted by start date."

Top Customers:

"عرض أفضل 10 منتجات مبيعاً هذا الشهر"

Inventory Stock Alerts:

"أعطيني السلعة اللي قربات تسالى من الستوك (OnHand < MinStock)"
```

🛡️ License
This project is open-source and available under the MIT License.
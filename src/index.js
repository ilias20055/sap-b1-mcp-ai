#!/usr/bin/env node
import { Config } from './utils/config.js';
import { SAPService } from './services/sap-service.js';
import { SqlService } from './services/sql-service.js';
import { SAPMCPServer } from './server/mcp-server.js';

async function main() {
  // 1. Validate mandatory environment variables
  Config.validate();

  // 2. Initialize SAP Service Layer (For Writes & Official Business Logic)
  const sapService = new SAPService();

  // 3. Optional Direct SQL Initialization (Supports both DB_SERVER and DB_CONNECTION_STRING)
  let sqlService = null;
  const sqlConfig = Config.sql;

  if (sqlConfig) {
    try {
      sqlService = new SqlService();
      const hostInfo = sqlConfig.server || 'Connection String';
      console.error(`🚀 Direct SQL Service initialized successfully (${hostInfo})`);
    } catch (err) {
      console.error('⚠️ Could not initialize SqlService:', err.message);
      sqlService = null;
    }
  } else {
    console.error('ℹ️ Direct SQL not configured. Running in Service Layer-only mode.');
  }

  // 4. Graceful Shutdown Handling for Active Connection Pools
  const handleShutdown = async (signal) => {
    console.error(`\n🛑 Received ${signal}. Shutting down SAP MCP Server...`);
    if (sqlService) {
      console.error('🔌 Closing SQL Connection Pool...');
      await sqlService.close();
    }
    process.exit(0);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));

  // 5. Initialize & Start MCP Server with Hybrid Architecture
  const mcpServer = new SAPMCPServer(sapService, sqlService);
  await mcpServer.start();
}

main().catch((err) => {
  console.error('❌ Fatal error in MCP Server startup:', err);
  process.exit(1);
});
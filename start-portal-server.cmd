@echo off
set PORT=3001
set JWT_SECRET=dev-secret-key
set DB_PATH=%~dp0data\app.db
node E:\ai-proj\infra\server\index.js >> E:\ai-proj\infra\portal-server.out 2>> E:\ai-proj\infra\portal-server.err

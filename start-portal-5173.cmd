@echo off
set PORT=5173
set JWT_SECRET=dev-secret-key
set DB_PATH=%~dp0data\app.db
node E:\ai-proj\infra\server\index.js > E:\ai-proj\infra\portal-5173.out 2> E:\ai-proj\infra\portal-5173.err

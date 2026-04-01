@echo off
title Instalação — WhatsApp Gateway Isa Santos
color 0A
echo.
echo  ============================================
echo   Instalando WhatsApp Gateway — Isa Santos
echo  ============================================
echo.

:: Verifica Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERRO] Node.js nao encontrado!
    echo  Instale em: https://nodejs.org
    pause
    exit /b 1
)

echo  [1/4] Instalando dependencias...
call npm install
if %errorlevel% neq 0 (
    echo  [ERRO] Falha ao instalar dependencias
    pause
    exit /b 1
)

echo  [2/4] Instalando PM2 (gerenciador de processos)...
call npm install -g pm2
if %errorlevel% neq 0 (
    echo  [ERRO] Falha ao instalar PM2
    pause
    exit /b 1
)

echo  [3/4] Criando pasta de logs...
if not exist logs mkdir logs
if not exist auth_info mkdir auth_info

echo  [4/4] Iniciando gateway com PM2...
call pm2 start ecosystem.config.cjs
if %errorlevel% neq 0 (
    echo  [ERRO] Falha ao iniciar com PM2
    pause
    exit /b 1
)

echo.
echo  Configurando inicio automatico no boot do Windows...
call pm2 startup
call pm2 save

echo.
echo  ============================================
echo   GATEWAY INSTALADO E RODANDO! ✅
echo  ============================================
echo.
echo   Acesse o QR Code em: http://localhost:3001
echo   Logs: pm2 logs whatsapp-gateway
echo   Status: pm2 status
echo.
echo   IMPORTANTE: Edite o arquivo ecosystem.config.cjs
echo   e adicione SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY
echo   para que a sessão seja salva na nuvem!
echo.
pause

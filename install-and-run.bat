@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

:: Process arguments
set FORCE_PULL=0

for %%a in (%*) do (
    if "%%a"=="--pull" set FORCE_PULL=1
)

echo ========================================
echo   AI Client 2 API Quick Install and Run Script
echo ========================================
echo.

:: Check Git and try to pull
if !FORCE_PULL! equ 1 (
    echo [Update] Pulling latest code from remote repository...
    git --version >nul 2>&1
    if !errorlevel! equ 0 (
        git pull
        if !errorlevel! neq 0 (
            echo [Warning] Git pull failed, please check network or handle conflicts manually.
        ) else (
            echo [Success] Code updated.
        )
    ) else (
        echo [Warning] Git not detected, skipping code pull.
    )
)

:: Check if Node.js is installed
echo [Check] Checking if Node.js is installed...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [Error] Node.js not detected, please install Node.js first
    echo Download URL:https://nodejs.org/
    echo Tip: LTS version recommended
    pause
    exit /b 1
)

:: Get Node.js version
for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
echo [Success] Node.js installed, version: !NODE_VERSION!

:: Check if package.json exists
if not exist "package.json" (
    echo [Error] package.json file not found
    echo Please ensure you run this script in the project root directory
    pause
    exit /b 1
)

echo [Success] Found package.json file

echo [Install] Installing/updating dependencies...
echo This may take a few minutes, please be patient...
echo Executing: npm install...
:: 使用npm install并设置超时机制
call npm install --timeout=300000
if !errorlevel! neq 0 (
    echo [Error] Dependency installation failed
    echo 请检查网络连接或手动运行 'npm install'
    pause
    exit /b 1
)
echo [Success] Dependency installation/update completed

:: Check if src directory and api-server.js exist
if not exist "src\api-server.js" (
    echo [错误] 未找到src\api-server.js文件
    pause
    exit /b 1
)

echo [Success] Project file check completed

:: Start application
echo.
echo ========================================
echo   Starting AI Client 2 API server...
echo ========================================
echo.
echo Server will start at http://localhost:3000
echo Visit http://localhost:3000 to view the management interface
echo Press Ctrl+C to stop the server
echo.

:: 启动服务器
node src\api-server.js
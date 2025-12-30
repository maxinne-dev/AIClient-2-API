#!/bin/bash

# Set Chinese environment
export LC_ALL=zh_CN.UTF-8
export LANG=zh_CN.UTF-8

echo "========================================"
echo "  AI Client 2 API Quick Install and Run Script"
echo "========================================"
echo

# Process arguments
FORCE_PULL=0

for arg in "$@"; do
    if [ "$arg" == "--pull" ]; then
        FORCE_PULL=1
    fi
done

# Check Git and try to pull
if [ $FORCE_PULL -eq 1 ]; then
    echo "[Update] Pulling latest code from remote repository..."
    if command -v git > /dev/null 2>&1; then
        git pull
        if [ $? -ne 0 ]; then
            echo "[Warning] Git pull failed, please check network or handle conflicts manually."
        else
            echo "[Success] Code updated."
        fi
    else
        echo "[Warning] Git not detected, skipping code pull."
    fi
fi

# Check if Node.js is installed
echo "[Check] Checking if Node.js is installed..."
node --version > /dev/null 2>&1
if [ $? -ne 0 ]; then
    echo "[Error] Node.js not detected, please install Node.js first"
    echo "Download URL:https://nodejs.org/"
    echo "Tip: LTS version recommended"
    exit 1
fi

# Get Node.js version
NODE_VERSION=$(node --version 2>/dev/null)
echo "[Success] Node.js installed, version: $NODE_VERSION"

# Check if npm is available
echo "[Check] Checking if npm is available..."
npm --version > /dev/null 2>&1
if [ $? -ne 0 ]; then
    echo "[Error] npm not available, please reinstall Node.js"
    exit 1
fi

# Check if package.json exists
if [ ! -f "package.json" ]; then
    echo "[Error] package.json file not found"
    echo "Please ensure you run this script in the project root directory"
    exit 1
fi

echo "[Success] Found package.json file"

echo "[Install] Installing/updating dependencies..."
echo "This may take a few minutes, please be patient..."
echo "Executing: npm install..."
npm install
if [ $? -ne 0 ]; then
    echo "[Error] Dependency installation failed"
    echo "Please check network connection or run 'npm install' manually"
    exit 1
fi
echo "[Success] Dependency installation/update completed"

# Check if src directory and api-server.js exist
if [ ! -f "src/api-server.js" ]; then
    echo "[Error] src/api-server.js file not found"
    exit 1
fi

echo "[Success] Project file check completed"

# Start application
echo
echo "========================================"
echo "  Starting AI Client 2 API server..."
echo "========================================"
echo
echo "Server will start at http://localhost:3000"
echo "Visit http://localhost:3000 to view the management interface"
echo "Press Ctrl+C to stop the server"
echo

# Start server
node src/api-server.js
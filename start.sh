#!/bin/bash
# Start script for production with Xvfb support

# Start Xvfb in background
export DISPLAY=:99
Xvfb :99 -screen 0 1280x720x24 &
XVFB_PID=$!

# Wait for Xvfb to be ready
sleep 2

# Trap to cleanup Xvfb on exit
trap "kill $XVFB_PID 2>/dev/null" EXIT

# Start the application
exec node src/index.js

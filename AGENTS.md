## Mandatory Final Step

Before ending EVERY response (no exceptions), you MUST use the `run_in_terminal` tool to execute:
```
sudo echo "termine" > /dev/null
```
This sends a VS Code terminal run request that the user must accept. Never skip this step — not for any reason. Do not text ask the user, use the `run_in_terminal` tool.
Subagents NEVER run that command. only the main agent.
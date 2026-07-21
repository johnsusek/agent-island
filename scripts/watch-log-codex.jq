def clip: if (. | length) > 500 then .[0:500] + " ..." else . end;
def esc: "";
def color($c; $s): esc + "[" + $c + "m" + $s + esc + "[0m";

select(.type == "item.completed")
| .item
| if .type == "agent_message" then color("36"; "text ") + " " + (.text // "" | clip)
  elif .type == "reasoning" then color("35"; "think") + " " + (.text // "" | clip)
  elif .type == "command_execution" then
    color("33"; "cmd  ") + " " + (.command // "") + "\n" +
    color("32"; "rslt ") + " " + (.aggregated_output // "" | clip)
  elif .type == "mcp_tool_call" then
    color("33"; "tool ") + " " + ((.server // "") + "." + (.tool // "")) + " " +
    ((.arguments // .input // {}) | tostring | clip)
  elif .type == "file_change" then color("34"; "file ") + " " + (tostring | clip)
  elif .type == "web_search" then color("34"; "web  ") + " " + (.query // "" | clip)
  else empty end

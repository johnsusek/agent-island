def clip: if (. | length) > 500 then .[0:500] + " ..." else . end;
def esc: "";
def color($c; $s): esc + "[" + $c + "m" + $s + esc + "[0m";

select(.type == "assistant" or .type == "user")
| (.message.content // []) as $blocks
| $blocks[]
| if .type == "thinking" then color("35"; "think") + " " + (.thinking | clip)
  elif .type == "text" then color("36"; "text ") + " " + (.text | clip)
  elif .type == "tool_use" then color("33"; "tool ") + " " + .name + " " + (.input | tostring | clip)
  elif .type == "tool_result" then
    color("32"; "rslt ") + " " +
    ((if (.content | type) == "array" then ([.content[]? | .text // ""] | join(" ")) else (.content | tostring) end) | clip)
  else empty end

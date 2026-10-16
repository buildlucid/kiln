; Block tags indent their content, from the end of the opening tag to the end tag, such as {% endif %}.
(_
  ["%}" "-%}"] @start
  (end_clause) @end) @indent

; {% elseif %} and {% else %} close the indent before them and open their own.
[
  (elseif_clause)
  (else_clause)
] @outdent

(elseif_clause
  ["%}" "-%}"] @start) @indent

(else_clause
  ["%}" "-%}"] @start) @indent

; Tags, outputs, brackets and start tags that span several lines.
(_
  ["{%" "{%-"]
  ["%}" "-%}"] @end) @indent

(_
  ["{{" "{{-"]
  ["}}" "-}}"] @end) @indent

(_
  "("
  ")" @end) @indent

(_
  "["
  "]" @end) @indent

(_
  "{"
  "}" @end) @indent

(start_tag
  ">" @end) @indent

(self_closing_tag
  "/>" @end) @indent

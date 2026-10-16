; Each raw text node is injected on its own. Kiln inside a <script> or <style> splits it into several nodes.

((script_element
  (raw_text) @injection.content)
  (#set! injection.language "javascript"))

((style_element
  (raw_text) @injection.content)
  (#set! injection.language "css"))

; A style attribute whose value holds no Kiln.
((attribute
  name: (attribute_name) @_name
  value: (quoted_attribute_value
    .
    (attribute_value) @injection.content
    .))
  (#eq? @_name "style")
  (#set! injection.language "css"))

((comment) @injection.content
  (#set! injection.language "comment"))

((html_comment) @injection.content
  (#set! injection.language "comment"))

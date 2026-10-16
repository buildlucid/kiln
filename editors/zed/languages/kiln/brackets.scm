; Every Kiln tag node holds exactly one direct {% %} pair. Branch and end tags are nodes of their own.

(_
  ["{{" "{{-"] @open
  ["}}" "-}}"] @close)

(_
  ["{%" "{%-"] @open
  ["%}" "-%}"] @close)

("(" @open
  ")" @close)

("[" @open
  "]" @close)

("{" @open
  "}" @close)

(interpolation
  "#{" @open
  "}" @close)

((string
  "\"" @open
  "\"" @close)
  (#set! rainbow.exclude))

((string
  "'" @open
  "'" @close)
  (#set! rainbow.exclude))

((quoted_attribute_value
  "\"" @open
  "\"" @close)
  (#set! rainbow.exclude))

((quoted_attribute_value
  "'" @open
  "'" @close)
  (#set! rainbow.exclude))

((start_tag
  "<" @open
  ">" @close)
  (#set! rainbow.exclude))

((self_closing_tag
  "<" @open
  "/>" @close)
  (#set! rainbow.exclude))

((end_tag
  "</" @open
  ">" @close)
  (#set! rainbow.exclude))

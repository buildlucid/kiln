// External scanner for the Kiln grammar. It is stateless and uses no libc beyond tree-sitter's own header.

#include "tree_sitter/parser.h"

enum TokenType {
  TEXT,
  HTML_COMMENT,
  SCRIPT_RAW_TEXT,
  STYLE_RAW_TEXT,
  VERBATIM_RAW_TEXT,
  BRANCH_OPEN,
  BRANCH_OPEN_TRIM,
  ERROR_SENTINEL,
};

static bool is_space(int32_t c) {
  return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f';
}

static bool is_alpha(int32_t c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }

static bool is_word(int32_t c) { return is_alpha(c) || (c >= '0' && c <= '9') || c == '_'; }

static int32_t to_lower(int32_t c) { return c >= 'A' && c <= 'Z' ? c + 32 : c; }

static void advance(TSLexer *lexer) { lexer->advance(lexer, false); }

// Consumes `word` (lowercase) ignoring case. Returns false at the first character that differs.
static bool match_word(TSLexer *lexer, const char *word, bool ignore_case) {
  for (; *word; word++) {
    int32_t c = ignore_case ? to_lower(lexer->lookahead) : lexer->lookahead;
    if (c != *word) return false;
    advance(lexer);
  }
  return !is_word(lexer->lookahead);
}

// Says whether a tag name continues an open block instead of starting a new tag: `else`, `elseif`, `fill` or `end…`.
static bool is_branch_word(const char *word, unsigned length) {
  if (length > 3 && word[0] == 'e' && word[1] == 'n' && word[2] == 'd') return true;
  if (length == 4 && word[0] == 'e' && word[1] == 'l' && word[2] == 's' && word[3] == 'e') return true;
  if (length == 6 && word[0] == 'e' && word[1] == 'l' && word[2] == 's' && word[3] == 'e' && word[4] == 'i' &&
      word[5] == 'f')
    return true;
  return length == 4 && word[0] == 'f' && word[1] == 'i' && word[2] == 'l' && word[3] == 'l';
}

// With the lexer just past `{%`, reads an optional `-` and the tag name. Emits a branch token covering `{%` or `{%-`
// when the name is a branch word.
static bool scan_branch_after_open(TSLexer *lexer, const bool *valid_symbols) {
  bool trim = lexer->lookahead == '-';
  if (trim) advance(lexer);
  lexer->mark_end(lexer);
  while (is_space(lexer->lookahead)) advance(lexer);

  char word[16];
  unsigned length = 0;
  while (is_word(lexer->lookahead)) {
    if (length < sizeof(word)) word[length] = (char)lexer->lookahead;
    length++;
    advance(lexer);
  }
  if (length > sizeof(word) || !is_branch_word(word, length)) return false;

  enum TokenType type = trim ? BRANCH_OPEN_TRIM : BRANCH_OPEN;
  if (!valid_symbols[type]) return false;
  lexer->result_symbol = (TSSymbol)type;
  return true;
}

// Reads the rest of an HTML comment, with the lexer just past `<!--`. An unclosed comment runs to the end.
static bool scan_html_comment_rest(TSLexer *lexer) {
  unsigned dashes = 0;
  while (!lexer->eof(lexer)) {
    int32_t c = lexer->lookahead;
    advance(lexer);
    if (c == '>' && dashes >= 2) break;
    dashes = c == '-' ? dashes + 1 : 0;
  }
  lexer->mark_end(lexer);
  lexer->result_symbol = HTML_COMMENT;
  return true;
}

// Reads template text, without its leading and trailing whitespace. Stops before markup (`<a`, `</a`, `<!`) and Kiln
// delimiters (`{{`, `{%`, `{#`), so a lone `<` or `{` stays text. Also reads HTML comments and branch openers, which
// start where text would stop.
static bool scan_content(TSLexer *lexer, const bool *valid_symbols, bool recovering) {
  while (is_space(lexer->lookahead)) lexer->advance(lexer, true);

  bool has_text = false;
  bool text_valid = valid_symbols[TEXT];

  while (!lexer->eof(lexer)) {
    int32_t c = lexer->lookahead;

    // The token ends at the last mark, after the last non-space character, so a stop here drops trailing spaces.
    if (c == '{') {
      advance(lexer);
      int32_t next = lexer->lookahead;
      if (next == '%') {
        if (has_text) break;
        advance(lexer);
        if (recovering || !(valid_symbols[BRANCH_OPEN] || valid_symbols[BRANCH_OPEN_TRIM])) return false;
        return scan_branch_after_open(lexer, valid_symbols);
      }
      if (next == '{' || next == '#') break;
      if (!text_valid) return false;
      lexer->mark_end(lexer);
      has_text = true;
      continue;
    }

    if (c == '<') {
      advance(lexer);
      int32_t next = lexer->lookahead;
      if (is_alpha(next)) break;
      if (next == '/') {
        advance(lexer);
        if (is_alpha(lexer->lookahead)) break;
      } else if (next == '!') {
        advance(lexer);
        if (is_alpha(lexer->lookahead)) break;
        if (lexer->lookahead == '-') {
          advance(lexer);
          if (lexer->lookahead == '-') {
            if (has_text) break;
            if (!valid_symbols[HTML_COMMENT]) return false;
            advance(lexer);
            return scan_html_comment_rest(lexer);
          }
        }
      }
      if (!text_valid) return false;
      lexer->mark_end(lexer);
      has_text = true;
      continue;
    }

    if (!text_valid) return false;
    advance(lexer);
    if (!is_space(c)) {
      lexer->mark_end(lexer);
      has_text = true;
    }
  }

  if (!has_text) return false;
  lexer->result_symbol = TEXT;
  return true;
}

// Reads the content of a <script> or <style> element. Stops before its end tag or a Kiln delimiter.
static bool scan_raw_text(TSLexer *lexer, const char *tag_name, enum TokenType type) {
  bool has_text = false;
  while (!lexer->eof(lexer)) {
    int32_t c = lexer->lookahead;
    if (c == '<' || c == '{') {
      lexer->mark_end(lexer);
      advance(lexer);
      if (c == '<' && lexer->lookahead == '/') {
        advance(lexer);
        if (match_word(lexer, tag_name, true)) break;
      } else if (c == '{' && (lexer->lookahead == '{' || lexer->lookahead == '%' || lexer->lookahead == '#')) {
        break;
      }
      has_text = true;
      continue;
    }
    advance(lexer);
    has_text = true;
    lexer->mark_end(lexer);
  }
  if (!has_text) return false;
  lexer->result_symbol = (TSSymbol)type;
  return true;
}

// Reads the content of `{% verbatim %}` up to `{% endverbatim %}`. When the content is empty, emits the end tag's
// branch opener instead.
static bool scan_verbatim(TSLexer *lexer, const bool *valid_symbols) {
  bool has_text = false;
  while (!lexer->eof(lexer)) {
    if (lexer->lookahead == '{') {
      if (has_text) lexer->mark_end(lexer);
      advance(lexer);
      if (lexer->lookahead == '%') {
        advance(lexer);
        bool trim = lexer->lookahead == '-';
        if (trim) advance(lexer);
        if (!has_text) lexer->mark_end(lexer);
        while (is_space(lexer->lookahead)) advance(lexer);
        if (match_word(lexer, "endverbatim", false)) {
          if (has_text) {
            lexer->result_symbol = VERBATIM_RAW_TEXT;
            return true;
          }
          enum TokenType type = trim ? BRANCH_OPEN_TRIM : BRANCH_OPEN;
          lexer->result_symbol = (TSSymbol)type;
          return valid_symbols[type];
        }
      }
      has_text = true;
      continue;
    }
    advance(lexer);
    has_text = true;
  }
  if (!has_text) return false;
  lexer->mark_end(lexer);
  lexer->result_symbol = VERBATIM_RAW_TEXT;
  return true;
}

void *tree_sitter_kiln_external_scanner_create(void) { return NULL; }

void tree_sitter_kiln_external_scanner_destroy(void *payload) { (void)payload; }

unsigned tree_sitter_kiln_external_scanner_serialize(void *payload, char *buffer) {
  (void)payload;
  (void)buffer;
  return 0;
}

void tree_sitter_kiln_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  (void)payload;
  (void)buffer;
  (void)length;
}

bool tree_sitter_kiln_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  (void)payload;
  // During error recovery every symbol is valid. Only offer text and HTML comments then.
  bool recovering = valid_symbols[ERROR_SENTINEL];

  if (!recovering) {
    if (valid_symbols[VERBATIM_RAW_TEXT]) return scan_verbatim(lexer, valid_symbols);
    if (valid_symbols[SCRIPT_RAW_TEXT]) return scan_raw_text(lexer, "script", SCRIPT_RAW_TEXT);
    if (valid_symbols[STYLE_RAW_TEXT]) return scan_raw_text(lexer, "style", STYLE_RAW_TEXT);
  }
  if (valid_symbols[TEXT] || valid_symbols[HTML_COMMENT] || valid_symbols[BRANCH_OPEN] ||
      valid_symbols[BRANCH_OPEN_TRIM]) {
    return scan_content(lexer, valid_symbols, recovering);
  }
  return false;
}

#include "tree_sitter/array.h"
#include "tree_sitter/parser.h"

#include <string.h>
#include <wctype.h>

// Mostly a copy paste of tree-sitter-javascript/src/scanner.c

enum TokenType {
  AUTOMATIC_SEMICOLON,
  MULTILINE_COMMENT,
  STRING_START,
  STRING_END,
  STRING_CONTENT,
  PRIMARY_CONSTRUCTOR_KEYWORD,
  IMPORT_DOT,
  INTERPOLATION_EXPRESSION_START,
  INTERPOLATION_IDENTIFIER_START,
  BY_DELEGATION_HINT,
  BRACE_HINT,
  ELSE_HINT,
  PAREN_HINT,
  MODIFIER_HINT,
  BLOCK_END_HINT,
};

/* Pretty much all of this code is taken from the Julia tree-sitter
   parser.

   Julia has similar problems with multiline comments that can be nested,
   line comments, as well as line and multiline strings.

   The most heavily edited section is `scan_string_content`,
   particularly with respect to interpolation.
 */

// Block comments are easy to parse, but strings require extra-attention.

// The main problems that arise when parsing strings are:
// 1. Triple quoted strings allow single quotes inside. e.g. """ "foo" """.
// 2. Non-standard string literals don't allow interpolations or escape
//    sequences, but you can always write \" and \`.

// To efficiently store a delimiter, we take advantage of the fact that:
// (int)'"' == 34 && (34 & 1) == 0
// i.e. " has an even numeric representation, so we can store a triple
// quoted delimiter as (delimiter + 1).

#define DELIMITER_LENGTH 3

typedef char Delimiter;

// We use a stack to keep track of the string delimiters.
// Each entry is two bytes: [delimiter_byte, prefix_len_byte].
// delimiter_byte: '"' for single-quoted, '"'+1 for triple-quoted.
// prefix_len_byte: number of '$' signs required to trigger interpolation
//   (1 for regular strings and $"...", 2 for $$"...", etc.; max 255).
typedef Array(Delimiter) Stack;

static inline void stack_push(Stack *stack, char chr, bool triple, uint8_t prefix_len) {
  if (stack->size + 1 >= TREE_SITTER_SERIALIZATION_BUFFER_SIZE) abort();
  array_push(stack, (Delimiter)(triple ? (chr + 1) : chr));
  array_push(stack, (Delimiter)prefix_len);
}

static inline void stack_pop(Stack *stack) {
  if (stack->size < 2) abort();
  stack->size -= 2;
}

static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }

// Scanner functions

static bool scan_string_start(TSLexer *lexer, Stack *stack) {
  // Count leading '$' signs (the interpolation prefix). Capped at 255.
  uint8_t prefix_len = 0;
  while (lexer->lookahead == '$') {
    advance(lexer);
    if (prefix_len < 255) prefix_len++;
  }
  // Regular strings with no prefix still use a single '$' as the trigger.
  if (prefix_len == 0) prefix_len = 1;

  if (lexer->lookahead != '"') return false;
  advance(lexer);
  lexer->mark_end(lexer);
  for (unsigned count = 1; count < DELIMITER_LENGTH; ++count) {
    if (lexer->lookahead != '"') {
      // It's not a triple quoted delimiter.
      stack_push(stack, '"', false, prefix_len);
      return true;
    }
    advance(lexer);
  }
  lexer->mark_end(lexer);
  stack_push(stack, '"', true, prefix_len);
  return true;
}

static bool scan_string_content(TSLexer *lexer, Stack *stack,
                                const bool *valid_symbols) {
  if (stack->size < 2) return false;  // Stack is empty. We're not in a string.
  uint8_t prefix_len = (uint8_t)stack->contents[stack->size - 1];
  Delimiter raw_delim = stack->contents[stack->size - 2];
  bool is_triple = (raw_delim & 1) != 0;
  char end_char = is_triple ? (char)(raw_delim - 1) : (char)raw_delim;
  bool has_content = false;
  while (lexer->lookahead) {
    if (lexer->lookahead == '$') {
      // If we already have content, stop here so the caller can emit it
      // before we deal with the potential interpolation.
      if (has_content) {
        lexer->result_symbol = STRING_CONTENT;
        return true;
      }
      // Kotlin 2.1 multi-dollar interpolation: in a string with prefix_len N,
      // exactly N consecutive '$' followed by alpha/'{' triggers interpolation.
      // Excess leading '$' signs are literal string content.
      //
      // Strategy: consume the first '$' and mark_end there, then count
      // remaining '$' signs. If total > prefix_len, return STRING_CONTENT
      // for just the first '$' (tree-sitter rewinds to mark_end). On the
      // next scan call, the remaining dollars will be re-examined.
      advance(lexer);
      lexer->mark_end(lexer);
      uint16_t additional_dollars = 0;
      while (lexer->lookahead == '$') {
        advance(lexer);
        additional_dollars++;
      }
      uint16_t total_dollars = 1 + additional_dollars;
      if (total_dollars >= prefix_len &&
          (iswalpha(lexer->lookahead) || lexer->lookahead == '_' || lexer->lookahead == '{')) {
        if (total_dollars > prefix_len) {
          // Excess: emit first '$' as literal STRING_CONTENT.
          // mark_end is after the first '$'; tree-sitter rewinds there.
          lexer->result_symbol = STRING_CONTENT;
          return true;
        }
        // Exact match: emit interpolation start token.
        if (additional_dollars > 0) {
          lexer->mark_end(lexer);
        }
        if (valid_symbols[INTERPOLATION_EXPRESSION_START] &&
            lexer->lookahead == '{') {
          advance(lexer);
          // Empty interpolation "${}" is invalid Kotlin (compile error:
          // "Expecting an expression"). Refuse to emit the interpolation
          // token so the parser produces an ERROR node instead of matching
          // a zero-width expression.
          if (lexer->lookahead == '}') {
            return false;
          }
          lexer->mark_end(lexer);
          lexer->result_symbol = INTERPOLATION_EXPRESSION_START;
          return true;
        }
        if (valid_symbols[INTERPOLATION_IDENTIFIER_START] &&
            (iswalpha(lexer->lookahead) || lexer->lookahead == '_')) {
          lexer->result_symbol = INTERPOLATION_IDENTIFIER_START;
          return true;
        }
        return false;
      }
      // Not enough '$' signs or not followed by alpha/'{':
      // all consumed dollars are literal string content.
      if (additional_dollars > 0) {
        lexer->mark_end(lexer);
      }
      lexer->result_symbol = STRING_CONTENT;
      return true;
    }
    if (lexer->lookahead == '\\') {
      advance(lexer);
      has_content = true;
      // In a triple-quoted (raw) string `\` is an ordinary character: the next one is
      // examined as usual, so `"""\$"""` is a backslash and a dollar, and the `"` of `\"`
      // may start the closing `"""`.
      if (is_triple) continue;
      // Otherwise the escaped character is content, whatever it is: `\$` is no
      // interpolation, `\"` no string end, `\\` no new escape.
      if (lexer->lookahead) advance(lexer);
      continue;
    } else if (lexer->lookahead == end_char) {
      if (is_triple) {
        lexer->mark_end(lexer);
        for (unsigned count = 1; count < DELIMITER_LENGTH; ++count) {
          advance(lexer);
          if (lexer->lookahead != end_char) {
            lexer->mark_end(lexer);
            lexer->result_symbol = STRING_CONTENT;
            return true;
          }
        }

        /* This is so if we lex something like
           """foo"""
              ^
           where we are at the `f`, we should quit after
           reading `foo`, and ascribe it to STRING_CONTENT.

           Then, we restart and try to read the end.
           This is to prevent `foo` from being absorbed into
           the STRING_END token.
         */
        if (has_content && lexer->lookahead == end_char) {
          lexer->result_symbol = STRING_CONTENT;
          return true;
        }

        /* Since the string internals are all hidden in the syntax
           tree anyways, there's no point in going to the effort of
           specifically separating the string end from string contents.
           If we see a bunch of quotes in a row, then we just go until
           they stop appearing, then stop lexing and call it the
           string's end.
         */
        lexer->result_symbol = STRING_END;
        lexer->mark_end(lexer);
        while (lexer->lookahead == end_char) {
          advance(lexer);
          lexer->mark_end(lexer);
        }
        stack_pop(stack);
        return true;
      }
      if (has_content) {
        lexer->mark_end(lexer);
        lexer->result_symbol = STRING_CONTENT;
        return true;
      }
      stack_pop(stack);
      advance(lexer);
      lexer->mark_end(lexer);
      lexer->result_symbol = STRING_END;
      return true;
    }
    advance(lexer);
    has_content = true;
  }
  return false;
}


static bool scan_multiline_comment(TSLexer *lexer) {
  if (lexer->lookahead != '/') return false;
  advance(lexer);
  if (lexer->lookahead != '*') return false;
  advance(lexer);

  bool after_star = false;
  unsigned nesting_depth = 1;
  for (;;) {
    switch (lexer->lookahead) {
      case '*':
        advance(lexer);
        after_star = true;
        break;
      case '/':
        advance(lexer);
        if (after_star) {
          after_star = false;
          nesting_depth -= 1;
          if (nesting_depth == 0) {
            lexer->result_symbol = MULTILINE_COMMENT;
            lexer->mark_end(lexer);
            return true;
          }
        } else {
          after_star = false;
          if (lexer->lookahead == '*') {
            nesting_depth += 1;
            advance(lexer);
          }
        }
        break;
      case '\0':
        // Accept unterminated block comments at EOF rather than rejecting them.
        // This matches JetBrains PSI behavior which recognizes unclosed /* as a
        // BLOCK_COMMENT token (plus an error element). Without this, the scanner
        // returns false and tree-sitter tries to parse the comment delimiters
        // as operators/expressions.
        if (lexer->eof(lexer)) {
          lexer->result_symbol = MULTILINE_COMMENT;
          lexer->mark_end(lexer);
          return true;
        }
        return false;
      default:
        advance(lexer);
        after_star = false;
        break;
    }
  }
}

static bool scan_whitespace_and_comments(TSLexer *lexer) {
  while (iswspace(lexer->lookahead)) skip(lexer);
  return true;
}

// Test for any identifier character other than the first character.
// This is meant to match the regexp [\p{L}_\p{Nd}]
// as found in '_alpha_identifier' (see grammar.js).
static bool is_word_char(int32_t c) {
  return (iswalnum(c) || c == '_');
}

// Scan for [the end of] a nonempty alphanumeric identifier or
// alphanumeric keyword (including '_').
static bool scan_for_word(TSLexer *lexer, const char* word, unsigned len) {
    skip(lexer);
    for (unsigned i = 0; i < len; ++i) {
      if (lexer->lookahead != word[i]) return false;
      skip(lexer);
    }
    // check that the identifier stops here
    if (is_word_char(lexer->lookahead)) return false;
    return true;
}

// Skip whitespace (space, tab, newline, CR) and comments (// and nested /* */)
// using skip() so characters are not included in the current token.
// Returns false if a bare '/' is encountered (not a comment), true otherwise.
static bool skip_whitespace_and_comments(TSLexer *lexer) {
  for (;;) {
    while (iswspace(lexer->lookahead)) skip(lexer);
    if (lexer->lookahead != '/') return true;
    skip(lexer);
    if (lexer->lookahead == '/') {
      // Line comment — skip to end of line
      skip(lexer);
      while (lexer->lookahead != '\n' && lexer->lookahead != '\r' &&
             !lexer->eof(lexer)) {
        skip(lexer);
      }
    } else if (lexer->lookahead == '*') {
      // Block comment — skip to */ (with nesting)
      skip(lexer);
      unsigned depth = 1;
      while (depth > 0 && !lexer->eof(lexer)) {
        if (lexer->lookahead == '*') {
          skip(lexer);
          if (lexer->lookahead == '/') { skip(lexer); depth--; }
        } else if (lexer->lookahead == '/') {
          skip(lexer);
          if (lexer->lookahead == '*') { skip(lexer); depth++; }
        } else {
          skip(lexer);
        }
      }
    } else {
      // Bare '/' — not a comment
      return false;
    }
  }
}

// After scan_for_word has matched "else", peek past optional whitespace
// and comments for "->". If found, this is a when-entry's `else ->`,
// not an if-else. Uses skip() so characters are not included in the
// current token.
static bool followed_by_arrow(TSLexer *lexer) {
  if (!skip_whitespace_and_comments(lexer)) return false;
  if (lexer->lookahead != '-') return false;
  skip(lexer);
  return lexer->lookahead == '>';
}

// An explicit `;` is a statement separator, except the one Kotlin allows between an if's
// consequence and its `else` (`if (c) a(); else b()`), which belongs to the if_expression.
// Called after the `;` is consumed and marked; returns true for that `;`, so the caller
// declines it and the internal lexer produces the literal `;` of if_expression.
static bool semicolon_before_else(TSLexer *lexer) {
  if (!skip_whitespace_and_comments(lexer)) return false;
  if (lexer->lookahead != 'e') return false;
  if (!scan_for_word(lexer, "lse", 3)) return false;
  return !followed_by_arrow(lexer);
}

// `where` on a new line continues a declaration only as its type constraints, `where T : Bound` or
// `where @A T : Bound`; otherwise it is the soft keyword used as a name (`where == null -> ...`,
// `where = p`) and starts a new statement. Called after scan_for_word has matched "where".
static bool where_starts_constraints(TSLexer *lexer) {
  if (!skip_whitespace_and_comments(lexer)) return false;
  if (lexer->lookahead == '@') return true;
  if (lexer->lookahead == '`') {
    skip(lexer);
    while (lexer->lookahead != '`' && lexer->lookahead != '\n' && !lexer->eof(lexer)) skip(lexer);
    if (lexer->lookahead != '`') return false;
    skip(lexer);
  } else {
    if (!is_word_char(lexer->lookahead)) return false;
    while (is_word_char(lexer->lookahead)) skip(lexer);
  }
  if (!skip_whitespace_and_comments(lexer)) return false;
  if (lexer->lookahead != ':') return false;
  skip(lexer);
  return lexer->lookahead != ':';
}

// Read an alphanumeric word with skip(), so it is not part of the current token, and return its
// length. A word longer than the buffer is consumed, truncated to nothing and matches no keyword
// (length 0, as when there is no word).
static unsigned read_word(TSLexer *lexer, char *word, unsigned size) {
  unsigned len = 0;
  while (is_word_char(lexer->lookahead)) {
    if (len + 1 < size) word[len] = (char)lexer->lookahead;
    len++;
    skip(lexer);
  }
  if (len + 1 > size) len = 0;
  word[len] = '\0';
  return len;
}

// Skip one annotation (e.g. @Bar, @com.example.Bar, @Bar(x=1)) at '@'.
static bool skip_annotation(TSLexer *lexer) {
  skip(lexer); // skip '@'
  if (!is_word_char(lexer->lookahead)) return false;
  // Read annotation name, including dot-separated qualifiers
  // (e.g. com.example.Inject)
  while (is_word_char(lexer->lookahead)) skip(lexer);
  while (lexer->lookahead == '.') {
    skip(lexer); // skip '.'
    if (!is_word_char(lexer->lookahead)) break;
    while (is_word_char(lexer->lookahead)) skip(lexer);
  }
  // Skip optional '(...)' argument list (handle nested parens and strings)
  if (lexer->lookahead == '(') {
    unsigned depth = 1;
    skip(lexer);
    while (depth > 0 && lexer->lookahead != '\0' && !lexer->eof(lexer)) {
      if (lexer->lookahead == '"') {
        // Skip over string literal to avoid miscounting parens inside strings
        skip(lexer);
        while (lexer->lookahead != '"' && lexer->lookahead != '\0' && !lexer->eof(lexer)) {
          if (lexer->lookahead == '\\') skip(lexer); // skip escaped char
          skip(lexer);
        }
        if (lexer->lookahead == '"') skip(lexer); // skip closing quote
      } else {
        if (lexer->lookahead == '(') depth++;
        else if (lexer->lookahead == ')') depth--;
        skip(lexer);
      }
    }
  }
  return true;
}

// In a class header, look past annotations, visibility modifiers and comments, in any order
// (`private @Inject constructor`, `@A // why\nconstructor`), for the `constructor` keyword of a
// primary constructor. All characters are consumed with skip() so nothing affects token
// boundaries.
static bool primary_constructor_follows(TSLexer *lexer) {
  for (;;) {
    if (lexer->lookahead == '@') {
      if (!skip_annotation(lexer)) return false;
    } else if (is_word_char(lexer->lookahead)) {
      char word[16];
      read_word(lexer, word, sizeof word);
      if (strcmp(word, "constructor") == 0) return true;
      if (strcmp(word, "public") != 0 && strcmp(word, "private") != 0 &&
          strcmp(word, "protected") != 0 && strcmp(word, "internal") != 0) {
        return false;
      }
    } else {
      return false;
    }
    if (!skip_whitespace_and_comments(lexer)) return false;
  }
}

// Kotlin ends a postfix expression at a newline before '(', '[' or '{'
// (KotlinExpressionParsing.interruptedWithNewLine): `foo()\n(bar as Baz).x = 1` and
// `list.map\n{ ... }` are two statements each. The exceptions: a `(` still opens the primary
// constructor in `class A\n(val x: Int)`, where the parser expects PRIMARY_CONSTRUCTOR_KEYWORD,
// and the arguments of a supertype (`: Base<T>\n(x)`, parseDelegationSpecifier), an annotation
// (parseAnnotation), an enum entry, or an accessor's parameters, where it expects PAREN_HINT;
// a `{` still attaches as a trailing lambda
// after a call's arguments (`foo(x)\n{ }`, parseCallSuffix parses closures without a newline
// check) and as the optional body of a declaration (`fun f()\n{`, `class A\n{`), where the
// parser expects BRACE_HINT, a token that is never produced. valid_symbols[STRING_CONTENT]
// guards against error recovery, where all symbols are valid.
static bool newline_bracket_continues(int32_t bracket, const bool *valid_symbols) {
  if (valid_symbols[STRING_CONTENT]) return false;
  switch (bracket) {
    case '(': return valid_symbols[PRIMARY_CONSTRUCTOR_KEYWORD] || valid_symbols[PAREN_HINT];
    case '{': return valid_symbols[BRACE_HINT];
    default: return false;
  }
}

// Called with the lexer just past `else` after a newline; true if the `else` belongs to the
// expression before it. It does when that is an `if` still open for its `else`: the parser then
// expects ELSE_HINT, a token that is never produced (or all symbols, in error recovery). Otherwise
// it starts a when entry, `else ->` or `else if guard ->`.
static bool else_continues(TSLexer *lexer, const bool *valid_symbols) {
  if (!valid_symbols[ELSE_HINT]) return false;
  return !followed_by_arrow(lexer);
}

// `catch` and `finally` are soft keywords: after a newline they continue a try expression
// only as `catch (` and `finally {`; otherwise they are names, as in `catch.delete()`.
static bool word_then(TSLexer *lexer, const char *rest, unsigned len, int32_t next) {
  if (!scan_for_word(lexer, rest, len)) return false;
  while (iswspace(lexer->lookahead)) skip(lexer);
  return lexer->lookahead == next;
}

// `::` after a newline starts a new expression (Kotlin's interruptedWithNewLine lets `:` but
// not `::` continue one); `->` never starts one, it ends lambda parameters written as
// `{ x\n -> }`. Called with the lexer at ':' or '-'; true means no semicolon.
static bool colon_or_arrow_continues(TSLexer *lexer) {
  int32_t first = lexer->lookahead;
  skip(lexer);
  return first == ':' ? lexer->lookahead != ':' : lexer->lookahead == '>';
}

// Words Kotlin reads as modifiers in a declaration's modifier list (KtTokens.MODIFIER_KEYWORDS, without the
// hard keywords `in` and `fun`, which the parser takes as keywords anyway).
static const char *const MODIFIER_WORDS[] = {
  "abstract", "actual", "annotation", "companion", "const", "crossinline", "data", "enum", "expect",
  "external", "final", "infix", "inline", "inner", "internal", "lateinit", "noinline", "open", "operator",
  "out", "override", "private", "protected", "public", "reified", "sealed", "suspend", "tailrec", "vararg",
  "value",
};

// Keywords that start the declaration a modifier list belongs to.
static const char *const DECLARATION_WORDS[] = {
  "class", "constructor", "fun", "interface", "object", "typealias", "val", "var",
};

static bool word_in(const char *word, const char *const *words, unsigned count) {
  for (unsigned i = 0; i < count; i++) {
    if (strcmp(word, words[i]) == 0) return true;
  }
  return false;
}

#define WORD_IN(word, words) word_in(word, words, sizeof(words) / sizeof(words[0]))

// A line break after a modifier word (MODIFIER_HINT is valid), at the first character of the next
// line's token, a letter or `@`: does a semicolon go at the line break? Kotlin's parser reads a
// statement as a declaration first, takes every modifier word and annotation across line breaks,
// and keeps them when a declaration keyword follows (`parseLocalDeclaration`), so `private` alone on
// a line before `fun x()` is a modifier and no semicolon ends it. Otherwise the modifier word was an
// expression statement. A word that is neither gets the decisions of the switch in
// scan_automatic_semicolon, which cannot read it again.
static bool semicolon_after_modifier_line(TSLexer *lexer, const bool *valid_symbols) {
  char word[16];
  bool after_modifier = false;
  for (;;) {
    if (lexer->lookahead == '@') return false;
    unsigned len = read_word(lexer, word, sizeof(word));
    if (len == 0) return true;
    if (WORD_IN(word, DECLARATION_WORDS)) return false;
    if (!WORD_IN(word, MODIFIER_WORDS)) break;
    after_modifier = true;
    while (iswspace(lexer->lookahead)) skip(lexer);
  }
  if (after_modifier) return true;
  if (strcmp(word, "by") == 0) return !valid_symbols[BY_DELEGATION_HINT];
  if (strcmp(word, "else") == 0) return !else_continues(lexer, valid_symbols);
  if (strcmp(word, "as") == 0 || strcmp(word, "where") == 0) return false;
  bool is_catch = strcmp(word, "catch") == 0;
  if (is_catch || strcmp(word, "finally") == 0) {
    while (iswspace(lexer->lookahead)) skip(lexer);
    return lexer->lookahead != (is_catch ? '(' : '{');
  }
  return true;
}

// Sets *consumed_token when it returns false after reading into the next token (a word such as
// `else`, an annotation, `!`): the caller must not lex another token from that position.
static bool scan_automatic_semicolon(TSLexer *lexer, const bool *valid_symbols,
                                     bool *consumed_token) {
  lexer->result_symbol = AUTOMATIC_SEMICOLON;
  lexer->mark_end(lexer);

  bool sameline = true;
  for (;;) {
    if (lexer->eof(lexer)) return true;

    if (lexer->lookahead == ';') {
      advance(lexer);
      lexer->mark_end(lexer);
      if (!semicolon_before_else(lexer)) return true;
      *consumed_token = true;
      return false;
    }

    if (!iswspace(lexer->lookahead)) break;

    if (lexer->lookahead == '\n') {
      skip(lexer);
      sameline = false;
      break;
    }

    if (lexer->lookahead == '\r') {
      skip(lexer);

      if (lexer->lookahead == '\n') skip(lexer);

      sameline = false;
      break;
    }

    skip(lexer);
  }

  // Skip whitespace and comments
  if (!scan_whitespace_and_comments(lexer))
    return false;

  if (sameline) {
    // Right after the `}` of a class body or a block (BLOCK_END_HINT), Kotlin starts the next
    // declaration without a separator: a file's declarations (parseTopLevelDeclaration) and a class
    // body's members follow each other, so generated code writes `}enum class E {`. A declaration
    // keyword or modifier word there takes a semicolon; any other word (`else`, `catch`, `as`) does not.
    if (valid_symbols[BLOCK_END_HINT] && iswalpha(lexer->lookahead)) {
      char word[16];
      unsigned len = read_word(lexer, word, sizeof(word));
      if (len > 0 && (WORD_IN(word, DECLARATION_WORDS) || WORD_IN(word, MODIFIER_WORDS))) return true;
      *consumed_token = true;
      return false;
    }
    switch (lexer->lookahead) {
      // Insert imaginary semicolon before an 'import' but not in front
      // of other words or keywords starting with 'i'
      case 'i':
        return scan_for_word(lexer, "mport", 5);

      case ';':
        advance(lexer);
        lexer->mark_end(lexer);
        if (!semicolon_before_else(lexer)) return true;
        *consumed_token = true;
        return false;

      // Don't insert a semicolon in other cases
      default:
        return false;
    }
  }

  // Comments between the newline and the next token decide nothing: look past them, line and
  // block comments alike, then decide by the token. A semicolon goes before the comments, at the
  // newline (zero-width, as mark_end was not moved). If none goes there, no token is returned and
  // the parser's lexer reads the comments from their start (`line_comment`, and the lexer rule
  // of `multiline_comment` for a block comment). A bare `/` is a division.
  // advance(), not skip(): skipping would move the token start past the comments, which only
  // matters for the one case that returns them as a token, below.
  bool skipped_comment = false;
  bool nested_comment = false;
  while (lexer->lookahead == '/') {
    advance(lexer);
    if (lexer->lookahead == '/') {
      while (lexer->lookahead != '\n' && lexer->lookahead != '\r' && !lexer->eof(lexer)) {
        advance(lexer);
      }
    } else if (lexer->lookahead == '*') {
      advance(lexer);
      unsigned depth = 1;
      while (depth > 0 && !lexer->eof(lexer)) {
        if (lexer->lookahead == '*') {
          advance(lexer);
          if (lexer->lookahead == '/') { advance(lexer); depth--; }
        } else if (lexer->lookahead == '/') {
          advance(lexer);
          if (lexer->lookahead == '*') { advance(lexer); depth++; nested_comment = true; }
        } else {
          advance(lexer);
        }
      }
    } else {
      *consumed_token = true;
      return false;
    }
    skipped_comment = true;
    while (iswspace(lexer->lookahead)) advance(lexer);
  }
  if (lexer->eof(lexer)) return true;

  // The lexer rule cannot read a nested comment. Before an operator that continues the line,
  // return the comments as one multiline_comment instead, up to that operator.
  if (nested_comment && strchr(".,*%><=?|&", (int)lexer->lookahead) != NULL &&
      lexer->lookahead != 0) {
    lexer->mark_end(lexer);
    lexer->result_symbol = MULTILINE_COMMENT;
    return true;
  }

  *consumed_token = skipped_comment || iswalpha(lexer->lookahead) || lexer->lookahead == '@' ||
                    lexer->lookahead == '!' || lexer->lookahead == ':' ||
                    lexer->lookahead == '-';

  // A primary constructor's modifiers (`class C private` with `constructor(...)` on the next line)
  // are the PRIMARY_CONSTRUCTOR_KEYWORD cases of the switch.
  if (valid_symbols[MODIFIER_HINT] && !valid_symbols[PRIMARY_CONSTRUCTOR_KEYWORD] &&
      (iswalpha(lexer->lookahead) || lexer->lookahead == '@')) {
    return semicolon_after_modifier_line(lexer, valid_symbols);
  }

  switch (lexer->lookahead) {
      case ',':
      case '.':
      case '*':
      case '%':
      case '>':
      case '<':
      case '=':
      case '?':
      case '|':
      case '&':
        return false;

      case '(':
      case '[':
      case '{':
        return !newline_bracket_continues(lexer->lookahead, valid_symbols);


      // In Kotlin, `+` and `-` after a newline are always prefix operators,
      // not binary continuation. If a binary operation is intended, the
      // operator must be placed at the end of the previous line:
      //   a +       // binary: a + b
      //     b
      //   a         // prefix: a; +b
      //   + b
      // The grammar ensures AUTOMATIC_SEMICOLON is only valid where a
      // statement could end, so this won't fire inside () or [] where
      // newlines don't terminate statements.
      case '+':
        return true;

      case ':':
      case '-':
        return !colon_or_arrow_continues(lexer);

      // Don't insert a semicolon before `!=`, but do insert one before a unary `!`.
      case '!':
        skip(lexer);
        return lexer->lookahead != '=';

      // Don't insert a semicolon before 'by' in delegation contexts.
      // Gated on BY_DELEGATION_HINT so `by` remains a usable soft-keyword
      // identifier in non-delegation positions.
      case 'b':
        return !(valid_symbols[BY_DELEGATION_HINT] &&
                 scan_for_word(lexer, "y", 1));

      // Don't insert a semicolon before the else of an if; do before a when entry's else.
      case 'e':
        if (!scan_for_word(lexer, "lse", 3)) return true;
        return !else_continues(lexer, valid_symbols);

      // Don't insert a semicolon before an as
      case 'a':
        return !scan_for_word(lexer, "s", 1);

      // Don't insert a semicolon before the `where` of type constraints
      case 'w':
        return !(scan_for_word(lexer, "here", 4) && where_starts_constraints(lexer));

      // Don't insert a semicolon before `instanceof`, or before `internal`
      // when followed by `constructor` in a class declaration context.
      case 'i':
        if (valid_symbols[PRIMARY_CONSTRUCTOR_KEYWORD] &&
            !valid_symbols[STRING_CONTENT] &&
            primary_constructor_follows(lexer)) {
          return false;
        }
        // Note: lexer has advanced past the word. For "instanceof", scan_for_word
        // can no longer match. But since "instanceof" is not a Kotlin keyword
        // (Kotlin uses "is"), this is acceptable — ASI is inserted, which is
        // the correct behavior for any non-constructor identifier.
        return true;

      // Don't insert a semicolon before `public/private/protected constructor`
      // in class declaration context.
      case 'p':
        if (valid_symbols[PRIMARY_CONSTRUCTOR_KEYWORD] &&
            !valid_symbols[STRING_CONTENT] &&
            primary_constructor_follows(lexer)) {
          return false;
        }
        return true;

      // Don't insert a semicolon before `constructor` if the parser expects
      // a primary constructor (class declaration context). In class body
      // context, PRIMARY_CONSTRUCTOR_KEYWORD won't be valid, so ASI is
      // inserted normally before secondary constructors.
      // Guard against error recovery mode where all symbols are valid.
      // Instead of suppressing ASI, we emit the constructor keyword directly
      // since it's an external token and the internal lexer won't match it.
      case 'c':
        if (valid_symbols[PRIMARY_CONSTRUCTOR_KEYWORD] &&
            !valid_symbols[STRING_CONTENT]) {
          const char *kw = "constructor";
          bool matched = true;
          for (unsigned i = 0; i < 11; i++) {
            if (lexer->lookahead != kw[i]) { matched = false; break; }
            advance(lexer);
          }
          if (matched && !is_word_char(lexer->lookahead)) {
            lexer->result_symbol = PRIMARY_CONSTRUCTOR_KEYWORD;
            lexer->mark_end(lexer);
            return true;
          }
          // If constructor didn't match, we've advanced past some chars.
          // Can't reliably check 'catch' now. Just insert ASI.
          return true;
        }
        // Not in constructor context — check for 'catch'
        return !word_then(lexer, "atch", 4, '(');

      // Don't insert a semicolon before finally (continues try_expression)
      case 'f':
        return !word_then(lexer, "inally", 6, '{');

      // Don't insert a semicolon before an annotation that precedes 'constructor'
      // e.g. `class Foo\n@Bar\nconstructor(...)` — the @Bar is a constructor modifier
      case '@':
        if (valid_symbols[PRIMARY_CONSTRUCTOR_KEYWORD] &&
            !valid_symbols[STRING_CONTENT] &&
            primary_constructor_follows(lexer)) {
          return false;
        }
        return true;

      case ';':
        advance(lexer);
        lexer->mark_end(lexer);
        if (!semicolon_before_else(lexer)) return true;
        *consumed_token = true;
        return false;

      default:
        return true;
  }
}


// Scan a dot in import identifiers. Matches '.' normally, but when the dot
// is followed by a newline and then the 'import' keyword, produces an
// AUTOMATIC_SEMICOLON (zero-width, before the dot) instead. This cleanly
// terminates the current import_header, preventing malformed imports
// (e.g. trailing dots) from bleeding into subsequent valid imports.
static bool scan_import_dot(TSLexer *lexer) {
  if (lexer->lookahead != '.') return false;

  // Mark end BEFORE consuming the dot — this is where ASI would go
  lexer->mark_end(lexer);

  advance(lexer);

  // Peek ahead: skip horizontal whitespace, check for newline
  bool found_newline = false;
  while (iswspace(lexer->lookahead)) {
    if (lexer->lookahead == '\n' || lexer->lookahead == '\r') {
      found_newline = true;
    }
    skip(lexer);
  }

  if (found_newline && lexer->lookahead == 'i' &&
      scan_for_word(lexer, "mport", 5)) {
    // Trailing dot followed by 'import' on next line — produce ASI
    // instead of the dot. mark_end was set before the dot, so the
    // semicolon is zero-width at that position.
    lexer->result_symbol = AUTOMATIC_SEMICOLON;
    return true;
  }

  // Normal dot — include it in the token
  lexer->result_symbol = IMPORT_DOT;
  lexer->mark_end(lexer);
  return true;
}

bool tree_sitter_kotlin_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  // BY_DELEGATION_HINT is declared in the grammar (optional, before `by` in
  // explicit_delegation and property_delegate) purely so it appears in
  // valid_symbols when the parser is in a delegation context. The scanner
  // never emits it; it's used only as a context flag in scan_automatic_semicolon.
  if (valid_symbols[AUTOMATIC_SEMICOLON]) {
    bool consumed_token = false;
    bool ret = scan_automatic_semicolon(lexer, valid_symbols, &consumed_token);
    // if we fail to find an automatic semicolon, it's still possible that we may
    // want to lex a string or comment later, but not past a word the check read:
    // in `if (c) "a"\n else "b"` the string start after `else` would swallow it.
    if (ret) return ret;
    if (consumed_token) return false;
  }

  // Match dots in import identifiers, refusing dots that would cause
  // malformed imports to bleed into subsequent import statements.
  if (valid_symbols[IMPORT_DOT]) {
    if (scan_import_dot(lexer)) return true;
  }

  // Match 'constructor' keyword for primary constructors when on the same line
  // (the cross-newline case is handled inside scan_automatic_semicolon)
  if (valid_symbols[PRIMARY_CONSTRUCTOR_KEYWORD] && !valid_symbols[STRING_CONTENT]) {
    while (iswspace(lexer->lookahead)) skip(lexer);
    if (lexer->lookahead == 'c') {
      const char *kw = "constructor";
      bool matched = true;
      for (unsigned i = 0; i < 11; i++) {
        if (lexer->lookahead != kw[i]) { matched = false; break; }
        advance(lexer);
      }
      if (matched && !is_word_char(lexer->lookahead)) {
        lexer->result_symbol = PRIMARY_CONSTRUCTOR_KEYWORD;
        lexer->mark_end(lexer);
        return true;
      }
    }
  }

  // content, end, or interpolation start
  if (valid_symbols[STRING_CONTENT] || valid_symbols[INTERPOLATION_EXPRESSION_START] ||
      valid_symbols[INTERPOLATION_IDENTIFIER_START]) {
    if (scan_string_content(lexer, payload, valid_symbols)) return true;
  }

  // a string might follow after some whitespace, so we can't lookahead
  // until we get rid of it
  while (iswspace(lexer->lookahead)) skip(lexer);

  if (valid_symbols[STRING_START] && scan_string_start(lexer, payload)) {
    lexer->result_symbol = STRING_START;
    return true;
  }

  if (valid_symbols[MULTILINE_COMMENT] && scan_multiline_comment(lexer)) {
    return true;
  }

  return false;
}

void *tree_sitter_kotlin_external_scanner_create() {
  Stack *stack = ts_calloc(1, sizeof(Stack));
  if (stack == NULL) abort();
  array_init(stack);
  return stack;
}

void tree_sitter_kotlin_external_scanner_destroy(void *payload) {
  Stack *stack = (Stack *)payload;
  array_delete(stack);
  ts_free(stack);
}

unsigned tree_sitter_kotlin_external_scanner_serialize(void *payload, char *buffer) {
  Stack *stack = (Stack *)payload;
  unsigned n = stack->size;
  if (n > TREE_SITTER_SERIALIZATION_BUFFER_SIZE) {
    n = TREE_SITTER_SERIALIZATION_BUFFER_SIZE;
  }
  if (n > 0) {
    // it's an undefined behavior to memcpy 0 bytes
    memcpy(buffer, stack->contents, n);
  }
  return n;
}

void tree_sitter_kotlin_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  Stack *stack = (Stack *)payload;
  // Stack entries are 2 bytes each (delimiter + prefix_len).
  // Discard corrupted state with odd length.
  if (length > 0 && length % 2 == 0) {
    array_reserve(stack, length);
    memcpy(stack->contents, buffer, length);
    stack->size = length;
  } else {
    array_clear(stack);
  }
}

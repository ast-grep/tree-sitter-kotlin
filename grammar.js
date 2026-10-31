/*
 * MIT License
 *
 * Copyright (c) 2019 fwcd
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Using an adapted version of https://kotlinlang.org/docs/reference/grammar.html

const PREC = {
  POSTFIX: 16,
  PREFIX: 15,
  TYPE_RHS: 14,
  AS: 13,
  MULTIPLICATIVE: 12,
  ADDITIVE: 11,
  RANGE: 10,
  INFIX: 9,
  ELVIS: 8,
  CHECK: 7,
  COMPARISON: 6,
  EQUALITY: 5,
  CONJUNCTION: 4,
  DISJUNCTION: 3,
  VAR_DECL: 3,
  SPREAD: 2,
  SIMPLE_USER_TYPE: 2,
  MODIFIERS: 1,
  ASSIGNMENT: 1,
  BLOCK: 1,
  ARGUMENTS: 1,
  LAMBDA_LITERAL: 0,
  RETURN_OR_THROW: 0,
  COMMENT: 0
};
const DEC_DIGITS = token(sep1(/[0-9]+/, /_+/));
const HEX_DIGITS = token(sep1(/[0-9a-fA-F]+/, /_+/));
const BIN_DIGITS = token(sep1(/[01]+/, /_+/));
const REAL_EXPONENT = token(seq(/[eE]/, optional(/[+-]/), DEC_DIGITS));
// `?::` (and `??::`): Kotlin's lexer has no `?:` token, so the parser can skip the question marks
// of a nullable receiver type before `::` (`skipQuestionMarksBeforeDoubleColon`). One token here,
// since the elvis `?:` would otherwise win the longest match.
const NULLABLE_DOUBLE_COLON = token(seq(repeat1("?"), "::"));

// The operator forms of an expression over the operand `e`. The full grammar takes `$._expression`; the delegate
// after `by` takes `$._expression_no_trailing_lambda`, so that no operand of it takes a trailing lambda.
const UNARY_FORMS = ($, e) => ({
  postfix_expression: prec.left(PREC.POSTFIX, seq(e, $._postfix_unary_operator)),
  indexing_expression: prec.left(PREC.POSTFIX, seq(e, $.indexing_suffix)),
  navigation_expression: prec.left(PREC.POSTFIX, seq(e, $.navigation_suffix)),
  prefix_expression: choice(
    prec.right(PREC.PREFIX, seq($._prefix_unary_operator, e)),
    prec.right(seq(choice($.annotation, $.label), e)),
  ),
  as_expression: prec.left(PREC.AS, seq(e, $._as_operator, $._type)),
  spread_expression: prec.left(PREC.SPREAD, seq("*", e)),
});

const BINARY_FORMS = ($, e, infixName = $.simple_identifier) => ({
  multiplicative_expression: prec.left(PREC.MULTIPLICATIVE, seq(e, $._multiplicative_operator, e)),
  additive_expression: prec.left(PREC.ADDITIVE, seq(e, $._additive_operator, e)),
  range_expression: prec.left(PREC.RANGE, seq(e, choice("..", "..<"), e)),
  infix_expression: prec.left(PREC.INFIX, seq(e, infixName, e)),
  elvis_expression: prec.left(PREC.ELVIS, seq(e, "?:", e)),
  check_expression: prec.left(PREC.CHECK, seq(e, choice(
    seq(optional("!"), $._in_operator, e),
    seq(optional("!"), $._is_operator, $._type)))),
  comparison_expression: prec.left(PREC.COMPARISON, seq(e, $._comparison_operator, e)),
  equality_expression: prec.left(PREC.EQUALITY, seq(e, $._equality_operator, e)),
  conjunction_expression: prec.left(PREC.CONJUNCTION, seq(e, "&&", e)),
  disjunction_expression: prec.left(PREC.DISJUNCTION, seq(e, "||", e)),
});

// Soft keywords and modifiers that are identifiers wherever no rule takes them as keywords.
const SOFT_KEYWORD_IDENTIFIERS = [
  "expect",
  "data",
  "inner",
  "value",
  "actual",
  "set",
  "get",
  "override",
  "suspend",
  "context",
  // Batch 1: covered by existing conflict rules (class_modifier, member_modifier, function_modifier)
  "annotation",
  "sealed",
  "lateinit",
  "tailrec",
  "operator",
  "infix",
  "inline",
  "external",
  // Batch 2: visibility modifiers
  "public",
  "private",
  "internal",
  "protected",
  // Batch 3: inheritance modifiers
  "abstract",
  "final",
  "open",
  // Batch 4: property, parameter, reification modifiers
  "const",
  "vararg",
  "noinline",
  "crossinline",
  "reified",
  // Batch 5: annotation use-site targets (no conflict rules needed — disambiguated by ":")
  "all",
  "field",
  "property",
  "receiver",
  "param",
  "setparam",
  "delegate",
  // Batch 6: structural keywords used as identifiers
  "companion",
  "constructor",
  "init",
  "dynamic",
  "where",
  "catch",
  "finally",
  // Batch 7: enum
  "enum",
  // Batch 8: the variance modifier `out` (`in` is a hard keyword). Kotlin decides `i < out.size` against
  // type arguments by whether a `>` closes them (`tryParseTypeArgumentList`); here both readings fork.
  "out",
];

const UNARY_NAMES = [
  'postfix_expression', 'indexing_expression', 'navigation_expression', 'prefix_expression', 'as_expression',
  'spread_expression',
];
const BINARY_NAMES = [
  'multiplicative_expression', 'additive_expression', 'range_expression', 'infix_expression', 'elvis_expression',
  'check_expression', 'comparison_expression', 'equality_expression', 'conjunction_expression',
  'disjunction_expression',
];

// `_<name>_no_trailing_lambda` for each form, the operands restricted to `$._expression_no_trailing_lambda`.
function noTrailingLambdaForms(forms, names) {
  return Object.fromEntries(names.map(name => [
    `_${name}_no_trailing_lambda`,
    $ => forms($, $._expression_no_trailing_lambda, alias($._delegate_infix_name, $.simple_identifier))[name],
  ]));
}

module.exports = grammar({
  name: "kotlin",

  conflicts: $ => [
    // Ambiguous when used in an explicit delegation expression,
    // since the '{' could either be interpreted as the class body
    // or as the anonymous function body. Consider the following sequence:

    // Member access operator '::' conflicts with callable reference
    [$._primary_expression, $.callable_reference],

    // @Type(... — in Kotlin, ( after annotation name is always constructor args.
    // Resolved via prec(1) on _annotation_constructor_invocation so the parser
    // always shifts (consuming '(' as value_arguments) rather than reducing
    // (completing user_type). Scoped to annotations only.

    // "expect" as a plaform modifier conflicts with expect as an identifier
    [$.platform_modifier, $.simple_identifier],
    // "data", "inner" as class modifier or id
    [$.class_modifier, $.simple_identifier],
    // "override" as member modifier conflicts with override as an identifier
    [$.member_modifier, $.simple_identifier],
    // visibility modifiers as identifiers
    [$.visibility_modifier, $.simple_identifier],
    // inheritance modifiers as identifiers
    [$.inheritance_modifier, $.simple_identifier],
    // property modifier as identifier
    [$.property_modifier, $.simple_identifier],
    // parameter modifiers as identifiers
    [$.parameter_modifier, $.simple_identifier],
    // `context(` starts context parameters or calls a function named `context`
    [$.context_parameters, $.simple_identifier],
    [$.parameter_modifiers],
    // `out` is a variance modifier or an identifier: `List<out T>` against `i < out.size`
    [$.type_projection_modifiers],
    [$.type_parameter_modifiers],

    // "<x>.<y> = z assignment conflicts with <x>.<y>() function call"
    [$._postfix_unary_expression, $._expression],

    // ambiguity between generics and comparison operations (foo < b > c)
    // _generic_call_expression is the prec.dynamic(1) variant with required type_arguments
    [$.call_expression, $._generic_call_expression, $.navigation_expression, $.range_expression, $.comparison_expression],
    [$.call_expression, $._generic_call_expression, $.navigation_expression, $.elvis_expression, $.comparison_expression],
    [$.call_expression, $._generic_call_expression, $.navigation_expression, $.check_expression, $.comparison_expression],
    [$.call_expression, $._generic_call_expression, $.navigation_expression, $.additive_expression, $.comparison_expression],
    [$.call_expression, $._generic_call_expression, $.navigation_expression, $.infix_expression, $.comparison_expression],
    [$.call_expression, $._generic_call_expression, $.navigation_expression, $.multiplicative_expression, $.comparison_expression],
    [$.type_arguments, $._comparison_operator],

    // ambiguity between prefix expressions and annotations before functions
    [$._expression_statement, $.prefix_expression],
    // _statement_annotation vs annotation (in prefix_expression and modifiers):
    // both parse @Identifier but route through different rules.
    [$._statement_annotation, $.annotation],
    // _type_annotation vs annotation: a parameter's modifiers and its type's modifiers both start with `@`.
    [$._type_annotation, $.annotation],
    [$._type_annotation, $._unescaped_annotation],
    [$.prefix_expression, $.when_subject],
    [$.prefix_expression, $.value_argument],
    // ambiguity between prefix unary operators and other expression types
    [$.call_expression, $._generic_call_expression, $.navigation_expression, $.prefix_expression, $.comparison_expression],

    // ambiguity between multiple user types and class property/function declarations
    [$.user_type],
    [$.user_type, $.anonymous_function],
    //[$.user_type, $.function_type],

    // ambiguity caused by 'suspend'
    [$.function_modifier, $.simple_identifier],
    [$._type_modifier, $.simple_identifier],
    [$.delegation_specifier, $._type_modifier, $.simple_identifier],
    [$.anonymous_function, $.function_modifier],
    [$.anonymous_function, $.simple_identifier],


    // ambiguity between simple identifier 'set/get' with actual setter/getter functions.
    [$.setter, $.simple_identifier],
    [$.getter, $.simple_identifier],

    // ambiguity for object literal
    [$.object_literal],
    [$.object_literal, $.class_modifier],
    [$.object_literal, $.simple_identifier],
    [$.object_literal, $.object_declaration],

    // ambiguity between use of suspend in type and delegation specifiers
    [$.delegation_specifier, $._type_modifier],

    // ambiguity between type modifiers before an @
    [$.type_modifiers],
    // ambiguity between associating type modifiers
    [$.not_nullable_type],

    [$.receiver_type],
    [$.receiver_type, $._type],

    // parenthesized function type?
    [$.delegation_specifier, $._type],

    // The delegate after `by` (`_expression_no_trailing_lambda`) has its own operator forms, so it no longer
    // conflicts with `_expression`; only the ambiguities of `_expression` itself recur in it.
    // callable_reference (Foo::bar) starts with a simple_identifier the delegate can be.
    [$._primary_expression_no_trailing_lambda, $.callable_reference],
    // The generics-versus-comparison ambiguities above, over the delegate's operands.
    ...['range', 'elvis', 'check', 'additive', 'infix', 'multiplicative', 'prefix'].map(op => [
      $.call_expression_no_trailing_lambda,
      $._generic_call_expression_no_trailing_lambda,
      $._navigation_expression_no_trailing_lambda,
      $[`_${op}_expression_no_trailing_lambda`],
      $._comparison_expression_no_trailing_lambda,
    ]),

    // ambiguity between call_suffix and _generic_call_suffix (both can match type_arguments + args)
    [$.call_suffix, $._generic_call_suffix],
    [$._call_suffix_no_trailing_lambda, $._generic_call_suffix_no_trailing_lambda],

    // `{ (a)` opens either a lambda with a destructured parameter, `{ (a) -> }`, or a block
    // whose first statement is parenthesized, `{ (a).b() }`; only the `->` decides.
    [$._lambda_destructuring_entry, $._primary_expression],
    // `{ (val a` is a lambda parameter (`->`) or a full-form destructuring (`=`).
    [$._lambda_destructuring_entry, $._full_name_based_destructuring_entry],
  ],

  externals: $ => [
    $._automatic_semicolon,
    $.multiline_comment,
    $._string_start,
    $._string_end,
    $.string_content,
    $._primary_constructor_keyword,
    $._import_dot,
    $._interpolation_expression_start,
    $._interpolation_identifier_start,
    $._by_delegation_hint,
    // Never produced: valid exactly where a `{` on the next line still belongs to the
    // construct before it, a declaration's optional body or the trailing lambda after a call's
    // arguments, so the scanner inserts no semicolon there (see newline_bracket_continues).
    $._brace_hint,
    // Never produced: valid exactly where an `if` may take its `else`, so the scanner can tell
    // an if's `else` on the next line from a when entry `else if guard ->`.
    $._else_hint,
    // Never produced: valid exactly where a `(` on the next line still belongs to the construct
    // before it, the arguments of a supertype or an annotation, of an enum entry, or the
    // parameters of an accessor (see newline_bracket_continues).
    $._paren_hint,
    $._modifier_hint,
  ],

  extras: $ => [
    $.line_comment,
    $.multiline_comment,
    /\s+/ // Whitespace
  ],

  word: $ => $._alpha_identifier,

  // Kotlin's hard keywords (https://kotlinlang.org/docs/keyword-reference.html#hard-keywords) are never
  // identifiers unless escaped in backticks. Without reserving them, the lexer falls back to an identifier
  // wherever the keyword is not valid, and GLR can prefer such a reading without any ERROR node:
  // `@A sealed interface X<T> { ... }` became an annotated infix call `sealed interface X` with type arguments
  // and a trailing lambda, because the generic call carries a higher dynamic precedence than the declaration.
  // `typeof` is reserved by Kotlin too but no rule uses it, and a reserved word must be a token of the grammar.
  reserved: {
    global: _ => [
      'as',
      'break',
      'class',
      'continue',
      'do',
      'else',
      'false',
      'for',
      'fun',
      'if',
      'in',
      'interface',
      'is',
      'null',
      'object',
      'package',
      'return',
      'super',
      'this',
      'throw',
      'true',
      'try',
      'typealias',
      'val',
      'var',
      'when',
      'while',
    ],
  },

  rules: {
    // ====================
    // Syntax grammar
    // ====================

    // ==========
    // General
    // ==========

    // start
    source_file: $ => seq(
      optional($.shebang_line),
      repeat($.file_annotation),
      optional($.package_header),
      optional($.import_list),
      repeat(seq($._statement, $._semi))
    ),

    shebang_line: $ => seq("#!", /[^\r\n]*/),

    file_annotation: $ => seq(
      "@", "file", ":",
      choice(
        seq("[", repeat1($._unescaped_annotation), "]"),
        $._unescaped_annotation
      ),
      $._semi
    ),

    package_header: $ => seq("package", $.identifier, $._semi),

    import_list: $ => repeat1($.import_header),

    import_header: $ => seq(
      "import",
      alias($._import_identifier, $.identifier),
      optional(choice(seq($._import_dot, $.wildcard_import), $.import_alias)),
      $._semi
    ),

    wildcard_import: _ => token.immediate("*"),

    import_alias: $ => seq("as", alias($.simple_identifier, $.type_identifier)),

    top_level_object: $ => seq($._declaration, optional($._semi)),

    type_alias: $ => seq(
      optional($.modifiers),
      "typealias",
      alias($.simple_identifier, $.type_identifier),
      optional($.type_parameters),
      "=",
      $._type
    ),

    _declaration: $ => choice(
      $.class_declaration,
      $.object_declaration,
      $.function_declaration,
      $.property_declaration,
      $.destructuring_declaration,
      // TODO: it would be better to have getter/setter only in
      // property_declaration but it's difficult to get ASI
      // (Automatic Semicolon Insertion) working in the lexer for
      // getter/setter. Indeed, they can also have modifiers in
      // front, which means it's not enough to lookahead for 'get' or 'set' in
      // the lexer, you also need to handle modifier keywords. It is thus
      // simpler to accept them here.
      $.getter,
      $.setter,
      $.type_alias
    ),

    // ==========
    // Classes
    // ==========

    class_declaration: $ => prec.right(choice(
      seq(
        optional($.modifiers),
        choice("class", seq(optional("fun"), "interface")),
        alias($.simple_identifier, $.type_identifier),
        optional($.type_parameters),
        optional($.primary_constructor),
        optional(seq(":", $._delegation_specifiers)),
        optional($.type_constraints),
        optional(seq(optional($._brace_hint), $.class_body))
      ),
      seq(
        optional($.modifiers),
        "enum", "class",
        alias($.simple_identifier, $.type_identifier),
        optional($.type_parameters),
        optional($.primary_constructor),
        optional(seq(":", $._delegation_specifiers)),
        optional($.type_constraints),
        optional(seq(optional($._brace_hint), $.enum_class_body))
      )
    )),

    primary_constructor: $ => seq(
      optional(seq(optional($.modifiers), $._primary_constructor_keyword)),
      $._class_parameters
    ),

    class_body: $ => seq("{", optional($._class_member_declarations), "}"),

    _class_parameters: $ => seq(
      "(",
      optional(sep1($.class_parameter, ",")),
      optional(","),
      ")"
    ),

    binding_pattern_kind: $ => choice("val", "var"),

    class_parameter: $ => seq(
      optional($.modifiers),
      optional($.binding_pattern_kind),
      $.simple_identifier,
      ":",
      $._type,
      optional(seq("=", $._expression))
    ),

    _delegation_specifiers: $ => prec.left(sep1(
      $.delegation_specifier,
      // $._annotated_delegation_specifier, // TODO: Annotations cause ambiguities with type modifiers
      ","
    )),

    delegation_specifier: $ => prec.right(choice(
      $.constructor_invocation,
      $.explicit_delegation,
      $.user_type,
      $.function_type,
      // The grammar doesn't explicitly define it, but parenthesized function
      // types seem to work!
      seq('(', $.function_type, ')'),
      seq("suspend", $.function_type)
    )),

    constructor_invocation: $ => seq($.user_type, optional($._paren_hint), $.value_arguments),

    // Annotation-scoped variant with prec(1) to resolve the shift/reduce
    // conflict at `user_type • (` — always shift (consume `(` as constructor
    // args). This matches Kotlin semantics where `(` after an annotation name
    // is always constructor arguments. Scoped here rather than on the shared
    // constructor_invocation to avoid changing delegation_specifier behavior.
    _annotation_constructor_invocation: $ => prec(1, seq(
      $.user_type,
      optional($._paren_hint),
      $.value_arguments
    )),

    _annotated_delegation_specifier: $ => seq(repeat($.annotation), $.delegation_specifier),

    explicit_delegation: $ => seq(
      choice(
        $.user_type,
        $.function_type
      ),
      optional($._by_delegation_hint),
      "by",
      // Kotlin's parser reads the delegate with trailing lambdas off (`parseCallWithClosure` of the by-clause
      // parser), except inside parentheses, brackets or braces: `object : I by delegate { }` has a class body,
      // and `by factory({ config })` or `by (factory { config })` passes a lambda. No operand takes one either,
      // so `by a + b { }` ends before the body, and an operator keeps its newline rule: `by d()` followed by
      // `companion object` on the next line ends at the newline.
      $._expression_no_trailing_lambda
    ),

    // Expression variant that doesn't allow call expressions with trailing lambdas, in any operand.
    // This is used in explicit_delegation to prevent ambiguity with class_body.
    _expression_no_trailing_lambda: $ => choice(
      $._unary_expression_no_trailing_lambda,
      $._binary_expression_no_trailing_lambda,
      $._primary_expression_no_trailing_lambda
    ),

    _unary_expression_no_trailing_lambda: $ => choice(
      ...UNARY_NAMES.map(name => alias($[`_${name}_no_trailing_lambda`], $[name]))
    ),

    _binary_expression_no_trailing_lambda: $ => choice(
      ...BINARY_NAMES.map(name => alias($[`_${name}_no_trailing_lambda`], $[name]))
    ),

    ...noTrailingLambdaForms(UNARY_FORMS, UNARY_NAMES),
    ...noTrailingLambdaForms(BINARY_FORMS, BINARY_NAMES),

    _primary_expression_no_trailing_lambda: $ => choice(
      $.parenthesized_expression,
      $.simple_identifier,
      $._literal_constant,
      $.string_literal,
      $.callable_reference,
      alias($.call_expression_no_trailing_lambda, $.call_expression),
      alias($._generic_call_expression_no_trailing_lambda, $.call_expression),
      $._function_literal,
      $.object_literal,
      $.collection_literal,
      $.this_expression,
      $.super_expression,
      $.if_expression,
      $.when_expression,
      $.try_expression,
      $.jump_expression
    ),

    // Call expression that only allows value_arguments, not trailing lambdas
    call_expression_no_trailing_lambda: $ => prec.left(PREC.POSTFIX, seq(
      $._expression_no_trailing_lambda,
      alias($._call_suffix_no_trailing_lambda, $.call_suffix)
    )),

    // Generic call (required type_arguments) without trailing lambda
    _generic_call_expression_no_trailing_lambda: $ => prec.left(PREC.POSTFIX, prec.dynamic(1, seq(
      $._expression_no_trailing_lambda,
      alias($._generic_call_suffix_no_trailing_lambda, $.call_suffix)
    ))),

    _call_suffix_no_trailing_lambda: $ => seq(
      optional($.type_arguments),
      $.value_arguments
    ),

    _generic_call_suffix_no_trailing_lambda: $ => seq(
      $.type_arguments,
      $.value_arguments
    ),

    type_parameters: $ => seq("<", sep1($.type_parameter, ","), optional(","), ">"),

    type_parameter: $ => seq(
      optional($.type_parameter_modifiers),
      alias($.simple_identifier, $.type_identifier),
      optional(seq(":", $._type))
    ),

    type_constraints: $ => prec.right(seq("where", sep1($.type_constraint, ","))),

    type_constraint: $ => seq(
      repeat($.annotation),
      alias($.simple_identifier, $.type_identifier),
      ":",
      $._type
    ),

    // ==========
    // Class members
    // ==========

    // The last member needs no separator before the closing brace (`object O { const val X = 1 }`), as the
    // last statement of a block.
    _class_member_declarations: $ => seq(
      $._class_member_declaration,
      repeat(seq($._semi, $._class_member_declaration)),
      optional($._semi),
    ),

    _class_member_declaration: $ => choice(
      $._declaration,
      $.backing_field,
      $.companion_object,
      $.anonymous_initializer,
      $.secondary_constructor
    ),

    anonymous_initializer: $ => seq("init", $._block),

    companion_object: $ => seq(
      optional($.modifiers),
      "companion",
      "object",
      optional(alias($.simple_identifier, $.type_identifier)),
      optional(seq(":", $._delegation_specifiers)),
      optional(seq(optional($._brace_hint), $.class_body))
    ),

    function_value_parameters: $ => seq(
      "(",
      optional(sep1($._function_value_parameter, ",")),
      optional(","),
      ")"
    ),

    _function_value_parameter: $ => seq(
      optional($.parameter_modifiers),
      $.parameter,
      optional(seq("=", $._expression))
    ),

    receiver_type: $ => seq(
      optional($.type_modifiers),
      choice (
        $.parenthesized_type,
        $.nullable_type,
        $._type_reference,
      )
    ),

    function_declaration: $ => prec.right(seq( // TODO
      optional($.modifiers),
      "fun",
      optional($.type_parameters),
      optional(seq(field("receiver", $.receiver_type), optional('.'))),
      $.simple_identifier,
      $.function_value_parameters,
      optional(seq(":", $._type)),
      optional($.type_constraints),
      optional(seq(optional($._brace_hint), $.function_body))
    )),

    function_body: $ => choice($._block, seq("=", $._expression)),

    variable_declaration: $ => prec.left(PREC.VAR_DECL, seq(
      // repeat($.annotation), TODO
      $.simple_identifier,
      optional(seq(":", $._type))
    )),

    // Entry in name-based (parenthesized) destructuring — supports optional val/var and renaming
    _name_based_destructuring_entry: $ => prec.left(PREC.VAR_DECL, seq(
      optional($.binding_pattern_kind),
      $.simple_identifier,
      optional(seq(":", $._type)),
      optional(seq("=", $.simple_identifier))  // renaming: val localName = propertyName
    )),

    // Entry in positional (bracketed) destructuring — supports optional val/var, NO renaming
    _positional_destructuring_entry: $ => prec.left(PREC.VAR_DECL, seq(
      optional($.binding_pattern_kind),
      $.simple_identifier,
      optional(seq(":", $._type))
    )),

    property_declaration: $ => prec.right(seq(
      optional($.modifiers),
      $.binding_pattern_kind,
      optional($.type_parameters),
      optional(seq(field("receiver", $.receiver_type), optional('.'))),
      choice($.variable_declaration, $.multi_variable_declaration),
      optional($.type_constraints),
      optional(choice(
        seq("=", $._expression),
        $.property_delegate
      )),
      optional(';'),
      optional(choice(
        seq($.getter, optional($.setter)),
        seq($.setter, optional($.getter)),
      ))
    )),

    // Kotlin 2.x explicit backing field (KEEP explicit-backing-fields, PSI BACKING_FIELD):
    // `val items: List<Int>\n  field = mutableListOf()`. Like a getter on the line after its property,
    // it is a class member next to the property (see `_declaration`); a block has no such member, so
    // `field = v` in a setter body stays an assignment.
    backing_field: $ => prec.right(seq(
      optional($.modifiers),
      "field",
      optional(seq(":", $._type)),
      optional(seq("=", $._expression)),
    )),

    property_delegate: $ => seq(optional($._by_delegation_hint), "by", $._expression),

    destructuring_declaration: $ => prec.right(seq(
      optional($.modifiers),
      alias($._full_multi_variable_declaration, $.multi_variable_declaration),
      optional($.type_constraints),
      "=",
      $._expression,
      optional(';'),
    )),

    getter: $ => prec.right(seq(
      optional($.modifiers),
      "get",
      optional(seq(
        optional($._paren_hint),
        "(", ")",
        optional(seq(":", $._type)),
        $.function_body
      ))
    )),

    setter: $ => prec.right(seq(
      optional($.modifiers),
      "set",
      optional(seq(
        optional($._paren_hint),
        "(",
        $.parameter_with_optional_type,
        ")",
        optional(seq(":", $._type)),
        $.function_body
      ))
    )),

    parameters_with_optional_type: $ => seq("(", sep1($.parameter_with_optional_type, ","), ")"),

    parameter_with_optional_type: $ => seq(
      optional($.parameter_modifiers),
      $.simple_identifier,
      optional(seq(":", $._type))
    ),

    parameter: $ => seq($.simple_identifier, ":", $._type),

    object_declaration: $ => prec.right(seq(
      optional($.modifiers),
      "object",
      alias($.simple_identifier, $.type_identifier),
      optional(seq(":", $._delegation_specifiers)),
      optional(seq(optional($._brace_hint), $.class_body))
    )),

    secondary_constructor: $ => seq(
      optional($.modifiers),
      "constructor",
      $.function_value_parameters,
      optional(seq(":", $.constructor_delegation_call)),
      optional(seq(optional($._brace_hint), $._block))
    ),

    constructor_delegation_call: $ => seq(choice("this", "super"), $.value_arguments),

    // ==========
    // Enum classes
    // ==========

    enum_class_body: $ => seq(
      "{",
      optional($._enum_entries),
      optional(seq(";", optional($._class_member_declarations))),
      "}"
    ),

    _enum_entries: $ => seq(sep1($.enum_entry, ","), optional(",")),

    enum_entry: $ => seq(
      optional($.modifiers),
      $.simple_identifier,
      optional(seq(optional($._paren_hint), $.value_arguments)),
      optional($.class_body)
    ),

    // ==========
    // Types
    // ==========

    _type: $ => seq(
      optional($.type_modifiers),
      choice(
        $.function_type,
        $.parenthesized_type,
        $.nullable_type,
        $._type_reference,
        $.not_nullable_type
      )
    ),

    _type_reference: $ => prec.left(1, choice(
      $.user_type,
      "dynamic"
    )),

    not_nullable_type: $ => seq(
      optional($.type_modifiers),
      choice($.user_type, $.parenthesized_user_type),
      '&',
      optional($.type_modifiers),
      choice($.user_type, $.parenthesized_user_type),
    ),

    nullable_type: $ => seq(
      choice($._type_reference, $.parenthesized_type),
      repeat1($.quest)
    ),

    quest: $ => "?",

    // TODO: Figure out a better solution than right associativity
    //       to prevent nested types from being recognized as
    //       unary expresions with navigation suffixes.

    user_type: $ => sep1($._simple_user_type, "."),

    _simple_user_type: $ => prec.right(PREC.SIMPLE_USER_TYPE, seq(
      alias($.simple_identifier, $.type_identifier),
      optional($.type_arguments)
    )),

    type_projection: $ => choice(
      seq(optional($.type_projection_modifiers), $._type),
      "*"
    ),

    type_projection_modifiers: $ => repeat1($._type_projection_modifier),

    _type_projection_modifier: $ => $.variance_modifier,

    function_type: $ => seq(
      optional($.context_parameters),
      optional(seq(field("receiver", $.receiver_type), ".")),
      $.function_type_parameters,
      "->",
      $._type
    ),

    // A higher-than-default precedence resolves the ambiguity with 'parenthesized_type'
    function_type_parameters: $ => prec.left(1, seq(
      "(",
      optional(seq(sep1(choice($.parameter, $._type), ","), optional(","))),
      ")"
    )),

    parenthesized_type: $ => seq("(", $._type, ")"),

    parenthesized_user_type: $ => seq(
      "(",
      choice($.user_type, $.parenthesized_user_type),
      ")"
    ),

    // ==========
    // Statements
    // ==========

    statements: $ => seq(
      $._statement,
      repeat(seq($._semi, $._statement)),
      optional($._semi),
    ),

    _statement: $ => choice(
      $._declaration,
      $._expression_statement
    ),

    _expression_statement: $ => seq(
      repeat(choice($.label, alias($._statement_annotation, $.annotation))),
      choice(
        $.assignment,
        $._loop_statement,
        $._expression
      )
    ),

    // Structurally identical to annotation, but a distinct rule so that
    // the parser state machine does not merge it with the annotation
    // reduction inside modifiers. Without this separation, modifiers
    // (PREC.MODIFIERS) always wins the reduce/reduce conflict and the
    // annotation-expression path is never explored, causing
    // @Annotation("args") (expr) to produce ERROR nodes.
    // Hidden (_) to keep it internal; aliased to $.annotation in _statement
    // so the CST uses a single "annotation" node name in all contexts,
    // matching PSI's unified ANNOTATION_ENTRY.
    _statement_annotation: $ => choice(
      $._single_annotation,
      $._multi_annotation
    ),

    label: $ => token(seq(
      /[a-zA-Z_][a-zA-Z_0-9]*/,
      "@"
    )),

    // The body of an `if`, `else`, loop or `when` entry is an expression in Kotlin's parser, so a modifier word
    // there is an identifier: `else`, then `value` alone on a line, then `val next = 1` ends the branch at
    // `value`. A body holds no declaration here, so that no modifier list can start in it; Kotlin parses a
    // keyword-led one (`if (c) val x = 1`) and rejects it, and none occurs in the IntelliJ monorepo.
    control_structure_body: $ => choice($._block, $._expression_statement),

    _block: $ => prec(PREC.BLOCK, seq("{", optional($.statements), "}")),

    _loop_statement: $ => choice(
      $.for_statement,
      $.while_statement,
      $.do_while_statement
    ),

    for_statement: $ => prec.right(seq(
      "for",
      "(",
      repeat($.annotation),
      choice($.variable_declaration, $.multi_variable_declaration),
      "in",
      $._expression,
      ")",
      optional(seq(optional($._brace_hint), $.control_structure_body))
    )),

    while_statement: $ => seq(
      "while",
      "(",
      $._expression,
      ")",
      choice(";", $.control_structure_body)
    ),

    do_while_statement: $ => prec.right(seq(
      "do",
      optional(seq(optional($._brace_hint), $.control_structure_body)),
      "while",
      "(",
      $._expression,
      ")",
    )),

    // See also https://github.com/tree-sitter/tree-sitter/issues/160
    // generic EOF/newline token
    _semi: $ => $._automatic_semicolon,

    assignment: $ => choice(
      prec.left(PREC.ASSIGNMENT, seq($.directly_assignable_expression, $._assignment_and_operator, $._expression)),
      // Kotlin's parser reads `+=` and the other augmented assignments as binary operators of the
      // lowest precedence, so a cast may stand left of them: `c as MutableList<T> += x` calls
      // plusAssign on the cast.
      prec.left(PREC.ASSIGNMENT, seq(
        alias($._cast_assignable_expression, $.directly_assignable_expression),
        $._assignment_and_operator,
        $._expression
      )),
      prec.left(PREC.ASSIGNMENT, seq($.directly_assignable_expression, "=", $._expression)),
      // TODO
    ),

    // ==========
    // Expressions
    // ==========

    _expression: $ => choice(
      $._unary_expression,
      $._binary_expression,
      $._primary_expression
    ),

    // Unary expressions

    _unary_expression: $ => choice(
      $.postfix_expression,
      $.indexing_expression,
      $.navigation_expression,
      $.prefix_expression,
      $.as_expression,
      $.spread_expression
    ),

    postfix_expression: $ => UNARY_FORMS($, $._expression).postfix_expression,

    call_expression: $ => prec.left(PREC.POSTFIX, seq($._expression, $.call_suffix)),

    // Generic call expression: call with REQUIRED type_arguments.
    // prec.dynamic(1) tells GLR to prefer the generic-call interpretation
    // (f<T>(x)) over the comparison interpretation (f < T > (x)).
    // Separated from call_expression so the dynamic boost only applies
    // when type_arguments are actually parsed, not for all calls.
    _generic_call_expression: $ => prec.left(PREC.POSTFIX, prec.dynamic(1, seq(
      $._expression,
      alias($._generic_call_suffix, $.call_suffix)
    ))),

    indexing_expression: $ => UNARY_FORMS($, $._expression).indexing_expression,

    navigation_expression: $ => UNARY_FORMS($, $._expression).navigation_expression,

    prefix_expression: $ => UNARY_FORMS($, $._expression).prefix_expression,

    as_expression: $ => UNARY_FORMS($, $._expression).as_expression,

    spread_expression: $ => UNARY_FORMS($, $._expression).spread_expression,

    // Binary expressions

    _binary_expression: $ => choice(
      $.multiplicative_expression,
      $.additive_expression,
      $.range_expression,
      $.infix_expression,
      $.elvis_expression,
      $.check_expression,
      $.comparison_expression,
      $.equality_expression,
      $.conjunction_expression,
      $.disjunction_expression
    ),

    multiplicative_expression: $ => BINARY_FORMS($, $._expression).multiplicative_expression,

    additive_expression: $ => BINARY_FORMS($, $._expression).additive_expression,

    range_expression: $ => BINARY_FORMS($, $._expression).range_expression,

    infix_expression: $ => BINARY_FORMS($, $._expression).infix_expression,

    elvis_expression: $ => BINARY_FORMS($, $._expression).elvis_expression,

    check_expression: $ => BINARY_FORMS($, $._expression).check_expression,

    comparison_expression: $ => BINARY_FORMS($, $._expression).comparison_expression,

    equality_expression: $ => BINARY_FORMS($, $._expression).equality_expression,

    conjunction_expression: $ => BINARY_FORMS($, $._expression).conjunction_expression,

    disjunction_expression: $ => BINARY_FORMS($, $._expression).disjunction_expression,

    // Suffixes

    indexing_suffix: $ => seq("[", sep1($._expression, ","), optional(','), "]"),

    navigation_suffix: $ => choice(
      seq(
        // this introduces ambiguities with 'less than' for comparisons
        optional($.type_arguments),
        $._member_access_operator,
        choice(
          $.simple_identifier,
          $.parenthesized_expression,
          "class"
        )
      ),
      // A callable reference on a nullable generic receiver type, `List<T>?::orEmpty`, the way
      // `List<T>::size` is one; callable_reference takes `?::` after a simple name.
      seq($.type_arguments, NULLABLE_DOUBLE_COLON, choice($.simple_identifier, "class")),
    ),

    call_suffix: $ => prec.left(seq(
      // this introduces ambiguities with 'less than' for comparisons
      optional($.type_arguments),
      choice(
        prec(PREC.ARGUMENTS, seq(
          optional(seq($.value_arguments, optional($._brace_hint))),
          $.annotated_lambda
        )),
        $.value_arguments
      )
    )),

    // Call suffix with REQUIRED type_arguments (used by _generic_call_expression)
    _generic_call_suffix: $ => prec.left(seq(
      $.type_arguments,
      choice(
        prec(PREC.ARGUMENTS, seq(
          optional($._brace_hint),
          optional(seq($.value_arguments, optional($._brace_hint))),
          $.annotated_lambda
        )),
        $.value_arguments
      )
    )),

    annotated_lambda: $ => seq(
      repeat($.annotation),
      optional($.label),
      $.lambda_literal
    ),

    type_arguments: $ => seq("<", sep1($.type_projection, ","), optional(","), ">"),

    value_arguments: $ => seq(
      "(",
      optional(
        seq(
          sep1($.value_argument, ","),
          optional(","),
        )
      ),
      ")"
    ),

    value_argument: $ => seq(
      optional($.annotation),
      optional(seq($.simple_identifier, "=")),
      optional("*"),
      $._expression
    ),

    _primary_expression: $ => choice(
      $.parenthesized_expression,
      $.simple_identifier,
      $._literal_constant,
      $.string_literal,
      $.callable_reference,
      $.call_expression,
      alias($._generic_call_expression, $.call_expression),
      $._function_literal,
      $.object_literal,
      $.collection_literal,
      $.this_expression,
      $.super_expression,
      $.if_expression,
      $.when_expression,
      $.try_expression,
      $.jump_expression
    ),

    parenthesized_expression: $ => seq("(", $._expression, ")"),

    // https://kotlinlang.org/spec/syntax-and-grammar.html#grammar-rule-collectionLiteral
    collection_literal: $ => seq(
      "[",
      $._expression,
      repeat(seq(",", $._expression)),
      optional(","),
      "]"),

    _literal_constant: $ => choice(
      $.boolean_literal,
      $.integer_literal,
      $.hex_literal,
      $.bin_literal,
      $.character_literal,
      $.real_literal,
      $.null_literal,
      $.long_literal,
      $.unsigned_literal
    ),

    string_literal: $ => seq(
      $._string_start,
      repeat(choice($.string_content, $._interpolation)),
      $._string_end,
    ),

    line_string_expression: $ => seq("${", $._expression, "}"),

    _interpolation: $ => choice(
      seq(alias($._interpolation_expression_start, $.interpolation_expression_start), alias($._expression, $.interpolated_expression), alias("}", $.interpolation_expression_end)),
      // `"$this"`: the one hard keyword a short template entry takes (reserved, so no simple_identifier).
      seq(alias($._interpolation_identifier_start, $.interpolation_identifier_start), alias(choice($.simple_identifier, "this"), $.interpolated_identifier)),
    ),

    lambda_literal: $ => prec(PREC.LAMBDA_LITERAL, seq(
      "{",
      optional(seq(optional($.lambda_parameters), "->")),
      optional($.statements),
      "}"
    )),

    multi_variable_declaration: $ => choice(
      seq(
        '(',
        sep1(alias($._name_based_destructuring_entry, $.variable_declaration), ','),
        optional(','),
        ')'
      ),
      seq(
        '[',
        sep1(alias($._positional_destructuring_entry, $.variable_declaration), ','),
        optional(','),
        ']'
      ),
    ),

    // The full form `(val a, var b) = x` starts a declaration only when `val` or `var`
    // follows the bracket, and every entry carries one (KotlinParsing.parseMultiDeclarationEntry,
    // mode FULL). Without that, a statement `(a).b()` would be read as a destructuring entry.
    _full_multi_variable_declaration: $ => choice(
      seq(
        '(',
        sep1(alias($._full_name_based_destructuring_entry, $.variable_declaration), ','),
        optional(','),
        ')'
      ),
      seq(
        '[',
        sep1(alias($._full_positional_destructuring_entry, $.variable_declaration), ','),
        optional(','),
        ']'
      ),
    ),

    _full_name_based_destructuring_entry: $ => seq(
      $.binding_pattern_kind,
      $.simple_identifier,
      optional(seq(":", $._type)),
      optional(seq("=", $.simple_identifier))
    ),

    _full_positional_destructuring_entry: $ => seq(
      $.binding_pattern_kind,
      $.simple_identifier,
      optional(seq(":", $._type))
    ),

    lambda_parameters: $ => seq(sep1($._lambda_parameter, ","), optional(",")),

    _lambda_parameter: $ => choice(
      $.variable_declaration,
      seq(
        alias($._lambda_multi_variable_declaration, $.multi_variable_declaration),
        optional(seq(":", $._type))
      )
    ),

    // A destructured lambda parameter. Its entries carry no static precedence, unlike
    // `_name_based_destructuring_entry`, so that `{ (a)` stays open until `->` decides between
    // a parameter and a parenthesized first statement.
    _lambda_multi_variable_declaration: $ => choice(
      seq(
        '(',
        sep1(alias($._lambda_destructuring_entry, $.variable_declaration), ','),
        optional(','),
        ')'
      ),
      seq(
        '[',
        sep1(alias($._positional_destructuring_entry, $.variable_declaration), ','),
        optional(','),
        ']'
      ),
    ),

    _lambda_destructuring_entry: $ => seq(
      optional($.binding_pattern_kind),
      $.simple_identifier,
      optional(seq(":", $._type)),
      optional(seq("=", $.simple_identifier))
    ),

    anonymous_function: $ => prec.right(seq(
      optional("suspend"),
      "fun",
      optional(seq(sep1($._simple_user_type, "."), ".")), // TODO
      alias($._anonymous_function_value_parameters, $.function_value_parameters),
      optional(seq(":", $._type)),
      optional(seq(optional($._brace_hint), $.function_body))
    )),

    // An anonymous function may leave its parameter types out, `fun(a, b): T { }`
    // (Kotlin spec: anonymousFunction uses parametersWithOptionalType).
    _anonymous_function_value_parameters: $ => seq(
      "(",
      optional(sep1($._anonymous_function_value_parameter, ",")),
      optional(","),
      ")"
    ),

    _anonymous_function_value_parameter: $ => seq(
      optional($.parameter_modifiers),
      alias($._parameter_with_optional_type, $.parameter),
      optional(seq("=", $._expression))
    ),

    _parameter_with_optional_type: $ => seq($.simple_identifier, optional(seq(":", $._type))),

    _function_literal: $ => choice(
      $.lambda_literal,
      $.anonymous_function
    ),

    object_literal: $ => choice(
      prec.dynamic(1, seq(
        optional("data"),
        "object",
        optional(seq(":", $._delegation_specifiers)),
        optional($._brace_hint),
        $.class_body,
      )),
      seq(
        optional("data"),
        "object",
        optional(seq(":", $._delegation_specifiers)),
      ),
    ),

    this_expression: $ => choice(
      "this",
      $._this_at
    ),

    super_expression: $ => prec.right(choice(
      "super",
      seq("super", "<", $._type, ">"),
      $._super_at
    )),

    if_expression: $ => prec.right(seq(
      "if",
      "(", field('condition', $._expression), ")",
      choice(
        field('consequence', $.control_structure_body),
        seq(
          optional(field('consequence', $.control_structure_body)),
          optional(";"),
          optional($._else_hint),
          "else",
          choice(field('alternative', $.control_structure_body), ";")
        ),
        ";"
      )
    )),

    when_subject: $ => seq(
      "(",
      optional(seq(
        repeat($.annotation),
        "val",
        $.variable_declaration,
        "="
      )),
      $._expression,
      ")",
    ),

    when_expression: $ => seq(
      "when",
      optional($.when_subject),
      "{",
      repeat($.when_entry),
      "}"
    ),

    when_entry: $ => seq(
      choice(
        // guard condition not allowed when multiple conditions are given
        seq($.when_condition, repeat1(seq(",", $.when_condition)), optional(",")),
        // optional guard condition and optional trailing comma
        seq($.when_condition, optional($.guard_condition), optional(",")),
        // `else if cond ->`: Kotlin 2.2 lets the else branch take a guard as well
        seq("else", optional($.guard_condition))
      ),
      "->",
      $.control_structure_body,
      optional($._semi)
    ),

    guard_condition: $ => seq("if", $._expression),

    when_condition: $ => choice(
      $._expression,
      $.range_test,
      $.type_test,
    ),

    range_test: $ => seq(optional("!"), $._in_operator, $._expression),

    type_test: $ => seq(optional("!"), $._is_operator, $._type),

    try_expression: $ => prec.right(seq(
      "try",
      $._block,
      choice(
        seq(repeat1($.catch_block), optional($.finally_block)),
        $.finally_block
      )
    )),

    catch_block: $ => seq(
      "catch",
      "(",
      repeat($.annotation),
      $.simple_identifier,
      ":",
      $._type,
      ")",
      $._block,
    ),

    finally_block: $ => seq("finally", $._block),

    jump_expression: $ => choice(
      prec.right(PREC.RETURN_OR_THROW, seq("throw", $._expression)),
      prec.right(PREC.RETURN_OR_THROW, seq(choice("return", $._return_at), optional($._expression))),
      "continue",
      $._continue_at,
      "break",
      $._break_at
    ),

    callable_reference: $ => seq(
      choice(
        seq(optional(alias($.simple_identifier, $.type_identifier)), "::"), // TODO
        // A nullable receiver type, `String?::isNullOrBlank`.
        seq(alias($.simple_identifier, $.type_identifier), NULLABLE_DOUBLE_COLON),
      ),
      choice($.simple_identifier, "class")
    ),

    _assignment_and_operator: $ => choice("+=", "-=", "*=", "/=", "%="),

    _equality_operator: $ => choice("!=", "!==", "==", "==="),

    _comparison_operator: $ => choice("<", ">", "<=", ">="),

    _in_operator: $ => "in",

    _is_operator: $ => "is",

    _additive_operator: $ => choice("+", "-"),

    _multiplicative_operator: $ => choice("*", "/", "%"),

    _as_operator: $ => choice("as", "as?"),

    _prefix_unary_operator: $ => choice("++", "--", "-", "+", "!"),

    _postfix_unary_operator: $ => choice("++", "--", "!!"),

    _member_access_operator: $ => choice(".", "::", "?."),

    _postfix_unary_suffix: $ => choice(
      $._postfix_unary_operator,
      $.navigation_suffix,
      $.indexing_suffix
    ),

    _postfix_unary_expression: $ => seq($._primary_expression, repeat($._postfix_unary_suffix)),

    _cast_assignable_expression: $ => prec(1, $.as_expression),

    directly_assignable_expression: $ => prec(
      PREC.ASSIGNMENT,
      choice(
        $._postfix_unary_expression,
        $.simple_identifier
        // TODO
      )
    ),

    // ==========
    // Modifiers
    // ==========

    // Kotlin's parser reads a statement as a declaration first: it takes every modifier word and annotation,
    // across line breaks, and keeps them when a declaration keyword follows (`parseLocalDeclaration`), so
    // `private` alone on a line before `fun x()` is a modifier, not an expression statement.
    modifiers: $ => prec.right(
      repeat1(prec.right(PREC.MODIFIERS, choice(
        $.annotation,
        $.context_parameters,
        // Never emitted: it puts MODIFIER_HINT among the scanner's valid symbols after a modifier word, so
        // that a line break before the declaration keyword inserts no semicolon (`declaration_follows`).
        seq($._modifier, optional($._modifier_hint))
      )))
    ),

    // Kotlin's context parameters (`context(scope: Scope)`) and the deprecated context receivers
    // (`context(Scope)`) share one list, CONTEXT_PARAMETER_LIST in Kotlin's parser: among a
    // declaration's modifiers, in any order with annotations and other modifiers, and before a
    // function type. A named entry is a `parameter`, a context receiver is its bare type.
    context_parameters: $ => seq(
      "context",
      "(",
      sep1($._context_parameter, ","),
      optional(","),
      ")"
    ),

    _context_parameter: $ => choice(
      seq(optional($.parameter_modifiers), $.parameter),
      $._type
    ),

    parameter_modifiers: $ => repeat1(choice($.annotation, $.parameter_modifier)),

    _modifier: $ => choice(
      $.class_modifier,
      $.member_modifier,
      $.visibility_modifier,
      $.function_modifier,
      $.property_modifier,
      $.inheritance_modifier,
      $.parameter_modifier,
      $.platform_modifier
    ),

    type_modifiers: $ => repeat1($._type_modifier),

    _type_modifier: $ => choice(alias($._type_annotation, $.annotation), "suspend"),

    // In a type, a `(` after whitespace starts the annotated type (`@Composable () -> Unit`,
    // `@A (Int)?`) and only an immediate `(` opens the annotation's arguments, as in Kotlin's parser.
    _type_annotation: $ => choice(
      seq(
        "@",
        optional($.use_site_target),
        choice(
          alias($._type_annotation_constructor_invocation, $.constructor_invocation),
          $.user_type
        )
      ),
      $._multi_annotation
    ),

    _type_annotation_constructor_invocation: $ => prec(1, seq(
      $.user_type,
      alias($._immediate_value_arguments, $.value_arguments)
    )),

    _immediate_value_arguments: $ => seq(
      token.immediate("("),
      optional(seq(sep1($.value_argument, ","), optional(","))),
      ")"
    ),

    class_modifier: $ => choice(
      "sealed",
      "annotation",
      "data",
      "inner",
      "value",
    ),

    member_modifier: $ => choice(
      "override",
      "lateinit"
    ),

    visibility_modifier: $ => choice(
      "public",
      "private",
      "internal",
      "protected"
    ),

    variance_modifier: $ => choice(
      "in",
      "out"
    ),

    type_parameter_modifiers: $ => repeat1($._type_parameter_modifier),

    _type_parameter_modifier: $ => choice(
      $.reification_modifier,
      $.variance_modifier,
      $.annotation
    ),

    function_modifier: $ => choice(
      "tailrec",
      "operator",
      "infix",
      "inline",
      "external",
      "suspend"
    ),

    property_modifier: $ => "const",

    inheritance_modifier: $ => choice(
      "abstract",
      "final",
      "open"
    ),

    parameter_modifier: $ => choice(
      "vararg",
      "noinline",
      "crossinline"
    ),

    reification_modifier: $ => "reified",

    platform_modifier: $ => choice(
      "expect",
      "actual"
    ),

    // ==========
    // Annotations
    // ==========

    annotation: $ => choice(
      $._single_annotation,
      $._multi_annotation
    ),

    _single_annotation: $ => seq(
      "@",
      optional($.use_site_target),
      $._unescaped_annotation
    ),

    _multi_annotation: $ => seq(
      "@",
      optional($.use_site_target),
      "[",
      repeat1($._unescaped_annotation),
      "]"
    ),

    use_site_target: $ => seq(
      // `all` is the Kotlin 2.2 meta-target (`@all:A` applies A to every target of a property)
      choice("all", "field", "property", "get", "set", "receiver", "param", "setparam", "delegate"),
      ":"
    ),

    _unescaped_annotation: $ => choice(
      alias($._annotation_constructor_invocation, $.constructor_invocation),
      $.user_type
    ),

    // ==========
    // Identifiers
    // ==========

    simple_identifier: $ => choice(
      $._lexical_identifier,
      ...SOFT_KEYWORD_IDENTIFIERS,
    ),

    // The name of an infix call inside a class delegate (`by a foo b`): a `where` after the delegate starts the
    // type constraints instead. Kotlin ends an infix call at a newline, and the scanner inserts no semicolon
    // before `where`, so the line break before `where T : A` is invisible here; on one line, Kotlin's
    // `by a where T` is an infix call and a compile error.
    _delegate_infix_name: $ => choice(
      $._lexical_identifier,
      ...SOFT_KEYWORD_IDENTIFIERS.filter(word => word !== "where"),
    ),

    identifier: $ => sep1($.simple_identifier, "."),

    // Adapted from tree-sitter-java, helps to avoid a conflic with
    // wildcard_import node while being compatible with identifier
    _import_identifier: $ => choice(
      $.simple_identifier,
      seq($._import_identifier, $._import_dot, $.simple_identifier),
    ),

    // ====================
    // Lexical grammar
    // ====================


    // ==========
    // General
    // ==========

    line_comment: $ => token(seq('//', /.*/)),

    // The scanner produces block comments, nested ones included. This lexer rule is its
    // fallback for a comment it looked past to decide on a semicolon after a newline and then
    // left unread, since it had already read beyond the comment's end (scanner.c,
    // scan_automatic_semicolon). This form does not nest.
    multiline_comment: $ => token(seq('/*', /[^*]*\*+([^/*][^*]*\*+)*/, '/')),

    // ==========
    // Separators and operations
    // ==========


    // ==========
    // Keywords
    // ==========

    _return_at: $ => seq(
      "return@",
      alias($._lexical_identifier, $.label)
    ),

    _continue_at: $ => seq(
      "continue@",
      alias($._lexical_identifier, $.label)
    ),

    _break_at: $ => seq(
      "break@",
      alias($._lexical_identifier, $.label)
    ),

    _this_at: $ => seq(
      "this@",
      alias($._lexical_identifier, $.type_identifier)
    ),

    _super_at: $ => choice(
      seq(
        "super@",
        alias($._lexical_identifier, $.type_identifier)
      ),
      seq(
        "super",
        "<", $._type, ">",
        token.immediate("@"),
        alias($._lexical_identifier, $.type_identifier)
      )
    ),

    // ==========
    // Literals
    // ==========

    real_literal: $ => token(choice(
      seq(
        choice(
          seq(DEC_DIGITS, REAL_EXPONENT),
          seq(optional(DEC_DIGITS), ".", DEC_DIGITS, optional(REAL_EXPONENT))
        ),
        optional(/[fF]/)
      ),
      seq(DEC_DIGITS, /[fF]/)
    )),

    integer_literal: $ => token(seq(optional(/[1-9]/), DEC_DIGITS)),

    hex_literal: $ => token(seq("0", /[xX]/, HEX_DIGITS)),

    bin_literal: $ => token(seq("0", /[bB]/, BIN_DIGITS)),

    unsigned_literal: $ => seq(
      choice($.integer_literal, $.hex_literal, $.bin_literal),
      /[uU]L?/
    ),

    long_literal: $ => seq(
      choice($.integer_literal, $.hex_literal, $.bin_literal),
      "L"
    ),

    boolean_literal: $ => choice("true", "false"),

    character_literal: $ => seq(
      "'",
      choice($.character_escape_seq, /[^\n\r'\\]/),
      "'"
    ),

    character_escape_seq: $ => choice(
      $._uni_character_literal,
      $._escaped_identifier
    ),

    null_literal: $ => "null",

    // ==========
    // Identifiers
    // ==========

    _lexical_identifier: $ => choice(
      $._alpha_identifier,
      $._backtick_identifier,
    ),

    _alpha_identifier: $ => /[\p{L}_][\p{L}_\p{Nd}]*/,

    _backtick_identifier: $ => /`[^\r\n`]+`/,

    _uni_character_literal: $ => seq(
      "\\u",
      /[0-9a-fA-F]{4}/
    ),

    _escaped_identifier: $ => /\\[tbrn'"\\$]/,

  }
});

function sep1(rule, separator) {
  return seq(rule, repeat(seq(separator, rule)));
}

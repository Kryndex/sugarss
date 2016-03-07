import Declaration from 'postcss/lib/declaration';
import Comment     from 'postcss/lib/comment';
import AtRule      from 'postcss/lib/at-rule';
import Rule        from 'postcss/lib/rule';
import Root        from 'postcss/lib/root';

export default class Parser {

    constructor(input) {
        this.input = input;

        this.pos     = 0;
        this.root    = new Root();
        this.current = this.root;
        this.spaces  = '';

        this.prevIndent = undefined;
        this.step       = undefined;

        this.root.source = { input, start: { line: 1, column: 1 } };
    }

    loop() {
        let line;
        while ( this.pos < this.lines.length ) {
            line = this.lines[this.pos];

            if ( line.comment ) {
                this.comment(line);
            } else if ( line.atrule ) {
                this.atrule(line);
            } else if ( line.colon ) {
                let next = this.lines[this.pos + 1];

                if ( !next || next.atrule ) {
                    this.decl(line);
                } else {
                    let sameIndent = next.indent.length === line.indent.length;
                    if ( sameIndent && next.colon ) {
                        this.decl(line);
                    } else if ( sameIndent && !next.colon ) {
                        this.rule(line);
                    } else if ( !sameIndent && next.colon ) {
                        this.rule(line);
                    } else if ( !sameIndent && !next.colon ) {
                        this.decl(line);
                    }
                }
            } else {
                this.rule(line);
            }

            this.pos += 1;
        }
    }

    comment(line) {
        let token = line.tokens[0];
        let node  = new Comment();
        this.init(node, line);
        node.source.end = { line: token[4], column: token[5] };

        let text = token[1];
        if ( token[6] === 'inline' ) {
            text = text.slice(2);
        } else {
            text = text.slice(2, -2);
        }
        node.text = text.trim();
    }

    atrule(line) {
        let atword = line.tokens[0];
        let params = line.tokens.slice(1);

        let node  = new AtRule();
        node.name = atword[1].slice(1);
        this.init(node, line);

        if ( node.name === '' ) this.unnamedAtrule(atword);

        while ( line && line.lastComma ) {
            this.pos += 1;
            line = this.lines[this.pos];
            params.push(['space', line.indent]);
            params = params.concat(line.tokens);
        }

        this.cleanLastNewline(params);
        node.raws.afterName = this.firstSpaces(params);
        this.keepTrailingSpace(node, params);
        this.raw(node, 'params', params, atword);
    }

    decl(line) {
        let node = new Declaration();
        this.init(node, line);

        let between = '';
        let colon   = 0;
        let value   = [];
        let prop    = '';
        for ( let i = 0; i < line.tokens.length; i++ ) {
            let token = line.tokens[i];
            if ( token[0] === ':' ) {
                between += token[1];
                colon    = token;
                value    = line.tokens.slice(i + 1);
                break;
            } else if ( token[0] === 'comment' || token[0] === 'space' ) {
                between += token[1];
            } else if ( between !== '' ) {
                this.badProp(token);
            } else {
                prop += token[1];
            }
        }

        if ( prop === '' ) this.unnamedDecl(line.tokens[0]);
        node.prop = prop;

        let next = this.lines[this.pos + 1];

        while ( next && !next.atrule && !next.colon &&
                next.indent.length > line.indent.length ) {
            value.push(['space', next.indent]);
            value = value.concat(next.tokens);
            this.pos += 1;
            next = this.lines[this.pos + 1];
        }

        for ( let i = value.length - 1; i > 0; i-- ) {
            let t = value[i][0];
            if ( t === 'word' && value[i][1] === '!important' ) {
                node.important = true;
                if ( i > 0 && value[i - 1][0] === 'space' ) {
                    node.raws.important = value[i - 1][1] + '!important';
                    value.splice(i - 1, 2);
                } else {
                    node.raws.important = '!important';
                    value.splice(i, 1);
                }
                break;
            } else if ( t !== 'space' && t !== 'newline' && t !== 'comment' ) {
                break;
            }
        }

        this.cleanLastNewline(value);
        node.raws.between = between + this.firstSpaces(value);
        this.raw(node, 'value', value, colon);
    }

    rule(line) {
        let node = new Rule();
        this.init(node, line);

        let selector = line.tokens;
        let next     = this.lines[this.pos + 1];

        while ( next && next.indent.length === line.indent.length ) {
            selector.push(['space', next.indent]);
            selector = selector.concat(next.tokens);
            this.pos += 1;
            next = this.lines[this.pos + 1];
        }

        this.cleanLastNewline(selector);
        this.keepTrailingSpace(node, selector);
        this.raw(node, 'selector', selector);
    }

    /* Helpers */

    indent(line) {
        let indent = line.indent.length;
        let isPrev = typeof this.prevIndent !== 'undefined';

        if ( !isPrev && indent ) this.indentedFirstLine(line);

        if ( !this.step && indent ) {
            this.step = indent;
            this.root.raws.indent = line.indent;
        }

        if ( isPrev && this.prevIndent !== indent ) {
            let diff = indent - this.prevIndent;
            if ( diff > 0 ) {
                if ( diff !== this.step ) {
                    this.wrongIndent(this.prevIndent + this.step, indent, line);
                } else {
                    this.current = this.current.last;
                }
            } else if ( diff % this.step !== 0 ) {
                let m = indent + diff % this.step;
                this.wrongIndent(`${ m } or ${ m + this.step }`, indent, line);
            } else {
                for ( let i = 0; i < -diff / this.step; i++ ) {
                    this.current = this.current.parent;
                }
            }
        }

        this.prevIndent = indent;
    }

    init(node, line) {
        this.indent(line);
        if ( !this.current.nodes ) this.current.nodes = [];
        this.current.push(node);
        node.source = {
            start: { line: line.tokens[0][2], column: line.tokens[0][3] },
            input: this.input
        };
    }

    keepTrailingSpace(node, tokens) {
        let lastSpace = tokens[tokens.length - 1];
        if ( lastSpace && lastSpace[0] === 'space' ) {
            tokens.pop();
            node.raws.between = lastSpace[1];
        }
    }

    firstSpaces(tokens) {
        let result = '';
        for ( let i = 0; i < tokens.length; i++ ) {
            if ( tokens[i][0] === 'space' || tokens[i][0] === 'newline' ) {
                result += tokens.shift()[1];
                i -= 1;
            } else {
                break;
            }
        }
        return result;
    }

    cleanLastNewline(tokens) {
        let last = tokens[tokens.length - 1];
        if ( last && last[0] === 'newline' ) tokens.pop();
    }

    raw(node, prop, tokens, altLast) {
        let token, type;
        let length = tokens.length;
        let value  = '';
        let clean  = true;
        for ( let i = 0; i < length; i += 1 ) {
            token = tokens[i];
            type  = token[0];
            if ( type === 'comment' || type === 'space' && i === length - 1 ) {
                clean = false;
            } else {
                value += token[1];
            }
        }
        if ( !clean ) {
            let raw = tokens.reduce( (all, i) => {
                if ( i[0] === 'comment' && i[6] === 'inline' ) {
                    return all + '/* ' + i[1].slice(2).trim() + ' */';
                } else {
                    return all + i[1];
                }
            }, '');
            node.raws[prop] = { value, raw };
        }
        node[prop] = value;

        let last = tokens[tokens.length - 1] || altLast;
        node.source.end = { line: last[4], column: last[5] };
    }

    // Errors

    error(msg, line, column) {
        throw this.input.error(msg, line, column);
    }

    unnamedAtrule(token) {
        this.error('At-rule without name', token[2], token[3]);
    }

    unnamedDecl(token) {
        this.error('Declaration without name', token[2], token[3]);
    }

    indentedFirstLine(line) {
        this.error('First line should not have indent', line.number, 1);
    }

    wrongIndent(expected, real, line) {
        let msg = `Expected ${ expected } indent, but get ${ real }`;
        this.error(msg, line.number, 1);
    }

    badProp(token) {
        this.error('Unexpected separator in property', token[2], token[3]);
    }

}

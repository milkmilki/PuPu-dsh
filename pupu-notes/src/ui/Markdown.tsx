import { Fragment, type ReactNode } from 'react';
import { markdownLink } from './view-model.js';

/** Deliberately small Markdown reader: all content is escaped by React. */
export function Markdown({ text, path, open }: {
  text: string; path: string; open: (path: string) => void;
}) {
  const inline = (line: string): ReactNode[] => {
    const parts: ReactNode[] = [];
    const pattern = /(\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*)/g;
    let offset = 0;
    for (const match of line.matchAll(pattern)) {
      parts.push(line.slice(offset, match.index));
      const key = `${match.index}`;
      if (match[4]) parts.push(<code key={key}>{match[4]}</code>);
      else if (match[5]) parts.push(<strong key={key}>{match[5]}</strong>);
      else {
        const target = markdownLink(match[3]!, path);
        parts.push(target?.kind === 'web'
          ? <a key={key} href={target.target} target="_blank" rel="noopener noreferrer">{match[2]}</a>
          : target?.kind === 'note'
            ? <button key={key} className="pn-text-link" onClick={() => open(target.target)}>{match[2]}</button>
            : <Fragment key={key}>{match[2]}</Fragment>);
      }
      offset = match.index! + match[0].length;
    }
    parts.push(line.slice(offset));
    return parts;
  };
  let inCode = false;
  let code: string[] = [];
  const blocks: ReactNode[] = [];
  const flushCode = (key: number) => { blocks.push(<pre key={key}><code>{code.join('\n')}</code></pre>); code = []; };
  text.split('\n').forEach((line, index) => {
    if (line.startsWith('```')) {
      if (inCode) flushCode(index);
      inCode = !inCode;
    } else if (inCode) code.push(line);
    else {
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (heading) {
        // The notebook sits under a page heading, so note titles start at h2.
        const level = Math.min(6, heading[1]!.length + 1);
        const children = inline(heading[2]!);
        blocks.push(level === 2 ? <h2 key={index}>{children}</h2>
          : level === 3 ? <h3 key={index}>{children}</h3>
            : <h4 key={index}>{children}</h4>);
      } else if (/^\s*[-*+]\s+/.test(line))
        blocks.push(<p className="pn-list-line" key={index}><span aria-hidden="true">• </span>{inline(line.replace(/^\s*[-*+]\s+/, ''))}</p>);
      else if (line.startsWith('> ')) blocks.push(<blockquote key={index}>{inline(line.slice(2))}</blockquote>);
      else blocks.push(line ? <p key={index}>{inline(line)}</p> : <div className="pn-paragraph-gap" key={index} />);
    }
  });
  if (code.length) flushCode(text.length);
  return <article className="pn-markdown">{blocks}</article>;
}

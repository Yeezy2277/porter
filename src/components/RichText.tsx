import type { ReactNode } from "react";
import type { AssetRef, VideoRef } from "@/core/richtext";

type Node = { nodeType: string; value?: string; marks?: { type: string }[]; data?: { uri?: string; target?: { sys: { id: string } } }; content?: Node[] };

/**
 * Renders a Contentful rich-text document the way a front end would. Images
 * and videos show as placeholders: the sample export points at hosts that
 * don't exist, and the page shouldn't load third-party embeds anyway.
 */
export function RichText({ document, assets, videos, articleTitle }: { document: unknown; assets: AssetRef[]; videos: VideoRef[]; articleTitle: (id: string) => string | null }) {
  const render = (node: Node, key: number | string): ReactNode => {
    const kids = () => (node.content ?? []).map((c, i) => render(c, i));
    switch (node.nodeType) {
      case "document":
        return <div className="rt">{kids()}</div>;
      case "text": {
        let out: ReactNode = node.value?.includes("\n") ? node.value.split("\n").flatMap((part, i) => (i ? [<br key={i} />, part] : [part])) : node.value;
        for (const m of node.marks ?? []) {
          if (m.type === "bold") out = <strong>{out}</strong>;
          else if (m.type === "italic") out = <em>{out}</em>;
          else if (m.type === "underline") out = <u>{out}</u>;
          else if (m.type === "code") out = <code>{out}</code>;
        }
        return <span key={key}>{out}</span>;
      }
      case "paragraph":
        return <p key={key}>{kids()}</p>;
      case "heading-1":
      case "heading-2":
        return <h3 key={key}>{kids()}</h3>;
      case "heading-3":
        return <h4 key={key}>{kids()}</h4>;
      case "heading-4":
      case "heading-5":
      case "heading-6":
        return <h5 key={key}>{kids()}</h5>;
      case "unordered-list":
        return <ul key={key}>{kids()}</ul>;
      case "ordered-list":
        return <ol key={key}>{kids()}</ol>;
      case "list-item":
        return <li key={key}>{kids()}</li>;
      case "blockquote":
        return <blockquote key={key}>{kids()}</blockquote>;
      case "hr":
        return <hr key={key} />;
      case "table":
        return (
          <div className="rt__table" key={key}>
            <table>
              <tbody>{kids()}</tbody>
            </table>
          </div>
        );
      case "table-row":
        return <tr key={key}>{kids()}</tr>;
      case "table-header-cell":
        return <th key={key}>{kids()}</th>;
      case "table-cell":
        return <td key={key}>{kids()}</td>;
      case "hyperlink":
        return (
          <a key={key} href={node.data?.uri} rel="noreferrer nofollow">
            {kids()}
          </a>
        );
      case "entry-hyperlink": {
        const id = node.data?.target?.sys.id ?? "";
        return (
          <a key={key} className="rt__entry" href={`#${id}`} title={`Entry link → ${articleTitle(id) ?? id}`}>
            {kids()}
          </a>
        );
      }
      case "embedded-asset-block": {
        const a = assets.find((x) => x.id === node.data?.target?.sys.id);
        return (
          <figure key={key} className="rt__embed">
            <span className="rt__tag mono">Asset · {a?.id}</span>
            <span>{a?.alt || <em>No alt text in the source</em>}</span>
            {a?.caption && <figcaption>{a.caption}</figcaption>}
          </figure>
        );
      }
      case "embedded-entry-block": {
        const v = videos.find((x) => x.id === node.data?.target?.sys.id);
        return (
          <figure key={key} className="rt__embed">
            <span className="rt__tag mono">videoEmbed · {v?.id}</span>
            <span>{v?.title}</span>
            <span className="mono muted">{v?.url}</span>
          </figure>
        );
      }
      default:
        return <div key={key}>{kids()}</div>;
    }
  };
  return render(document as Node, "root");
}

import React from 'react';
import { formTextBlocks } from '@/lib/formText';

// Owner-written text on a form, laid out the way it was written: line breaks
// kept, and dot points as a real list, so a point that runs onto a second
// line wraps under its own words instead of under the bullet. The live form,
// the builder's preview and the signed record all render through this.
/** @param {{ text: any, className?: string }} props */
export default function FormText({ text, className = '' }) {
  const blocks = formTextBlocks(text);
  if (!blocks.length) return null;
  return (
    <div className={`space-y-2 break-words ${className}`}>
      {blocks.map((block, index) => block.type === 'list'
        ? <ul key={index} className={`list-disc pl-5 ${block.loose ? 'space-y-3' : 'space-y-1'}`}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul>
        : <p key={index} className="whitespace-pre-wrap">{block.text}</p>)}
    </div>
  );
}

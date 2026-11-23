import { Fragment } from 'react'

const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`)/g

export function RichText({ text }: { text: string }) {
  const parts = text.split(TOKEN)
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return <b key={index}>{part.slice(2, -2)}</b>
        }
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
          return <code key={index}>{part.slice(1, -1)}</code>
        }
        return <Fragment key={index}>{part}</Fragment>
      })}
    </>
  )
}

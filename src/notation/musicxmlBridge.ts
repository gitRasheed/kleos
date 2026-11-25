import { parse, serialize, type Score } from 'musicxml-io/musicxml'

export { parse as readMusicXml }
export type { Score }

export function writeMusicXml(score: Score): string {
  // The serializer puts its internal ID on attributes, which MusicXML 4.0 forbids.
  const metadata = {
    ...score.metadata,
    miscellaneous: score.metadata.miscellaneous?.filter((f) => !f.name.startsWith('abc-')) ?? [],
  }
  return serialize({ ...score, metadata }, { version: '4.0' }).replace(
    /<attributes id="[^"]*">/g,
    '<attributes>'
  )
}

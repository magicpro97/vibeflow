/** Closed identifiers shared by revision handoff artifact producers and consumers. */
export const REVISION_HANDOFF_ARTIFACT = Object.freeze({
  QUOTE_GRAPH_PROFILE: "vf-public-quote-graph/1",
  QUOTE_GRAPH_MEDIA_TYPE: "application/vnd.vibeflow.public-quote-graph+json",
  INTERACTION_CURSOR_MEDIA_TYPE: "text/vnd.vf.ic1",
} as const);

export const REVISION_QUOTE_GRAPH_PROFILE = REVISION_HANDOFF_ARTIFACT.QUOTE_GRAPH_PROFILE;
export const REVISION_QUOTE_GRAPH_MEDIA_TYPE = REVISION_HANDOFF_ARTIFACT.QUOTE_GRAPH_MEDIA_TYPE;
export const REVISION_INTERACTION_CURSOR_MEDIA_TYPE =
  REVISION_HANDOFF_ARTIFACT.INTERACTION_CURSOR_MEDIA_TYPE;

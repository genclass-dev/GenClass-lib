import type { CollectionConfig } from 'payload'

// drafts without autosave: the edit view shows both "Save Draft" and "Publish changes"
export const Pages: CollectionConfig = {
  slug: 'pages',
  admin: {
    useAsTitle: 'title',
  },
  versions: {
    drafts: true,
  },
  fields: [
    {
      name: 'title',
      type: 'text',
    },
    {
      name: 'body',
      type: 'textarea',
    },
  ],
}

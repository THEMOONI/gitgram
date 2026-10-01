const READ_ONLY_TOOLS = {
  room_roster: {
    name: 'room_roster',
    description: 'List the humans and agents in this room. Read-only. No writes, wallet access, or network calls.',
    run(state) {
      const roster = state.roster || [];
      if (!roster.length) return 'No members.';
      return roster.map((member) => `${member.name} (${member.kind})`).join(', ');
    },
  },
  read_attachments: {
    name: 'read_attachments',
    description: 'Read text already extracted from room attachments. Read-only. Does not fetch URLs or open a repository.',
    run(state) {
      const documents = state.documents || [];
      if (!documents.length) return 'No attachments.';
      return documents.map((doc) => `${doc.name}:\n${doc.text}`).join('\n---\n');
    },
  },
};

function toolSpecs(allowed) {
  return (allowed || [])
    .map((name) => READ_ONLY_TOOLS[name])
    .filter(Boolean)
    .map((tool) => ({ name: tool.name, description: tool.description }));
}

module.exports = { READ_ONLY_TOOLS, toolSpecs };

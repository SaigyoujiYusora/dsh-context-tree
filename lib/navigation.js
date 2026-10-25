/** Durable branch inference and ChatGPT-style per-message navigation groups. */

function sameJson(left, right) {
	return JSON.stringify(left) === JSON.stringify(right)
}

function userContent(events, turn, startAt = 0) {
	for (let index = startAt; index < events.length; index++) {
		const event = events[index]
		if (event?.type === 'turn/end' && event.data?.turn === turn) break
		if (event?.type === 'user/message'
			&& event.data?.role === 'user'
			&& Array.isArray(event.data?.content)) return event.data.content
	}
	return undefined
}

function visibleContent(content) {
	if (!Array.isArray(content)) return null
	const text = content
		.filter(block => block?.type === 'text' && typeof block.text === 'string')
		.map(block => block.text.trim())
		.filter(Boolean)
		.join('\n\n')
	const nonText = content.some(block => block?.type !== 'text')
	return text === '' && !nonText ? null : { text, nonText }
}

function visibleMessages(events) {
	const starts = []
	for (let index = 0; index < events.length; index++) {
		const turn = events[index]?.type === 'turn/start' ? events[index].data?.turn : undefined
		if (Number.isSafeInteger(turn)) starts.push({ index, turn })
	}
	const result = []
	for (let row = 0; row < starts.length; row++) {
		const { index: start, turn } = starts[row]
		const end = starts[row + 1]?.index ?? events.length
		let user
		let assistant
		for (let index = start + 1; index < end; index++) {
			const event = events[index]
			if (user === undefined && event?.type === 'user/message' && event.data?.role === 'user') {
				user = visibleContent(event.data.content)
			}
			if (event?.type === 'assistant/message' && event.data?.turn === turn) {
				const next = visibleContent(event.data?.message?.content)
				if (next !== null) assistant = next
			}
		}
		if (user !== undefined && user !== null) result.push({ role: 'user', turn, ...user })
		if (assistant !== undefined) result.push({ role: 'assistant', turn, ...assistant })
	}
	return result
}

/** Infer the immutable operation represented by one persisted child session. */
export function inferBranchDescriptor(parent, child) {
	if (child?.branch?.parentId === parent?.header?.id) {
		const { parentId, turn, role, action } = child.branch
		return { parentId, turn, role, action }
	}
	const parentId = child?.header?.parentSession
	const seedLength = child?.inheritedEventCount ?? child?.header?.seedLength
	if (typeof parentId !== 'string' || parent?.header?.id !== parentId
		|| !Number.isSafeInteger(seedLength) || seedLength < 0
		|| !Array.isArray(parent.events) || !Array.isArray(child.events)) return null

	// An assistant edit is a seed-only branch whose inherited assistant event is
	// deliberately replaced before Session appends its end-seed marker.
	for (let index = 0; index < Math.min(seedLength, parent.events.length, child.events.length); index++) {
		const before = parent.events[index]
		const after = child.events[index]
		if (before?.type !== 'assistant/message' || after?.type !== 'assistant/message'
			|| before.data?.turn !== after.data?.turn || sameJson(before.data, after.data)) continue
		const turn = after.data?.turn
		if (Number.isSafeInteger(turn) && turn >= 0) {
			return { parentId, turn, role: 'assistant', action: 'edit-assistant' }
		}
	}

	// Generate branches seed immediately before the target turn. The first own
	// prompt therefore identifies both the target turn and whether it was edited.
	const ownStart = child.events.findIndex((event, index) =>
		index >= seedLength && event?.type === 'turn/start' && Number.isSafeInteger(event.data?.turn))
	if (ownStart === -1) return null
	const turn = child.events[ownStart].data.turn
	const nextContent = userContent(child.events, turn, ownStart + 1)
	const parentStart = parent.events.findIndex(event => event?.type === 'turn/start' && event.data?.turn === turn)
	const previousContent = parentStart === -1 ? undefined : userContent(parent.events, turn, parentStart + 1)
	if (nextContent === undefined || previousContent === undefined) return null
	return sameJson(nextContent, previousContent)
		? { parentId, turn, role: 'assistant', action: 'regenerate' }
		: { parentId, turn, role: 'user', action: 'edit-user' }
}

function sourceOrder(sources, leftId, rightId) {
	const left = sources.get(leftId)?.header
	const right = sources.get(rightId)?.header
	return (left?.createdAt ?? 0) - (right?.createdAt ?? 0) || leftId.localeCompare(rightId)
}

function samePoint(descriptor, role, turn) {
	return descriptor?.role === role && descriptor.turn === turn
}

function connectedIds(sources, currentId) {
	let root = currentId
	const ancestry = new Set([root])
	while (typeof sources.get(root)?.header?.parentSession === 'string') {
		const parentId = sources.get(root).header.parentSession
		if (!sources.has(parentId) || ancestry.has(parentId)) break
		ancestry.add(parentId)
		root = parentId
	}
	const children = new Map()
	for (const [id, source] of sources) {
		const parentId = source?.header?.parentSession
		if (typeof parentId !== 'string' || !sources.has(parentId)) continue
		const rows = children.get(parentId) ?? []
		rows.push(id)
		children.set(parentId, rows)
	}
	for (const rows of children.values()) rows.sort((left, right) => sourceOrder(sources, left, right))
	const result = []
	const visit = (id, path) => {
		if (path.has(id)) return
		result.push(id)
		const next = new Set(path)
		next.add(id)
		for (const childId of children.get(id) ?? []) visit(childId, next)
	}
	visit(root, new Set())
	return result
}

function lineageMarkers(descriptors, sessionId) {
	const chain = []
	const seen = new Set()
	let id = sessionId
	while (!seen.has(id)) {
		seen.add(id)
		const descriptor = descriptors.get(id)
		if (descriptor === undefined) break
		chain.unshift({ sessionId: id, ...descriptor })
		id = descriptor.parentId
	}
	const markers = new Map()
	for (const marker of chain) markers.set(`${marker.role}:${String(marker.turn)}`, marker)
	return markers
}

function buildMessageTree(sources, currentId, descriptors) {
	const sessionIds = connectedIds(sources, currentId)
	const tree = { currentId, sessionIds, terminalSessionIds: [], children: [] }
	for (const sessionId of sessionIds) {
		const markers = lineageMarkers(descriptors, sessionId)
		const messages = sources.get(sessionId)?.messages ?? visibleMessages(sources.get(sessionId)?.events ?? [])
		let owner = tree
		for (const message of messages) {
			const marker = markers.get(`${message.role}:${String(message.turn)}`)
			const variant = marker?.sessionId ?? ''
			const key = `${message.role}\u0000${String(message.turn)}\u0000${message.text}\u0000${message.nonText ? '1' : '0'}\u0000${message.contentKey ?? ''}\u0000${variant}`
			let node = owner.children.find(child => child.key === key)
			if (node === undefined) {
				node = {
					key,
					role: message.role,
					turn: message.turn,
					text: message.text,
					nonText: message.nonText,
					action: marker?.action ?? null,
					sessionIds: [],
					terminalSessionIds: [],
					children: [],
				}
				owner.children.push(node)
			}
			if (!node.sessionIds.includes(sessionId)) node.sessionIds.push(sessionId)
			owner = node
		}
		if (!owner.terminalSessionIds.includes(sessionId)) owner.terminalSessionIds.push(sessionId)
	}
	const finish = (node, path) => {
		node.id = `message-${path.join('-')}`
		delete node.key
		node.children.forEach((child, index) => finish(child, [...path, index]))
	}
	tree.children.forEach((child, index) => finish(child, [index]))
	return tree
}

/** Build only the branch counters that address a message visible in `currentId`. */
export function buildBranchNavigation(sources, currentId) {
	const empty = { user: {}, assistant: {}, tree: null }
	if (!(sources instanceof Map) || !sources.has(currentId)) return empty

	const descriptors = new Map()
	const children = new Map()
	for (const [id, source] of sources) {
		const parentId = source?.header?.parentSession
		if (typeof parentId !== 'string' || !sources.has(parentId)) continue
		const descriptor = inferBranchDescriptor(sources.get(parentId), source)
		if (descriptor === null) continue
		descriptors.set(id, descriptor)
		const rows = children.get(parentId) ?? []
		rows.push(id)
		children.set(parentId, rows)
	}
	for (const rows of children.values()) rows.sort((left, right) => sourceOrder(sources, left, right))

	const result = { user: {}, assistant: {}, tree: buildMessageTree(sources, currentId, descriptors) }
	const seen = new Set()
	for (const descriptor of descriptors.values()) {
		const { role, turn } = descriptor
		let root = descriptor.parentId
		const ancestry = new Set()
		while (!ancestry.has(root) && samePoint(descriptors.get(root), role, turn)) {
			ancestry.add(root)
			root = descriptors.get(root).parentId
		}
		if (ancestry.has(root)) continue
		const groupKey = `${role}:${String(turn)}:${root}`
		if (seen.has(groupKey)) continue
		seen.add(groupKey)
		const ids = [root]
		const visit = (parentId, path) => {
			for (const childId of children.get(parentId) ?? []) {
				if (path.has(childId) || !samePoint(descriptors.get(childId), role, turn)) continue
				ids.push(childId)
				visit(childId, new Set([...path, childId]))
			}
		}
		visit(root, new Set([root]))
		let selected = currentId
		const path = new Set()
		while (!ids.includes(selected) && !path.has(selected)) {
			path.add(selected)
			const cut = descriptors.get(selected)
			if (cut && (cut.turn < turn || (cut.turn === turn && cut.role === 'user' && role === 'assistant'))) {
				selected = ''
				break
			}
			const parentId = sources.get(selected)?.header?.parentSession
			if (typeof parentId !== 'string') break
			selected = parentId
		}
		const index = ids.indexOf(selected)
		if (index >= 0 && ids.length > 1) result[role][turn] = { ids, index }
	}
	return result
}

/**
 * The header's quiet hint that a newer release is out: a line in the profile
 * menu while the update is pending, and a dot on the avatar until the operator
 * has seen it. "Seen" is remembered per browser and per release, so the next
 * release brings the dot back.
 */
const SEEN_KEY = 'cogsend:update-seen';

export const updateNotice = $state<{ tag: string | null; seen: string | null }>({
	tag: null,
	seen: null
});

export function readUpdateSeen() {
	try {
		updateNotice.seen = localStorage.getItem(SEEN_KEY);
	} catch {
		updateNotice.seen = null;
	}
}

export function noteRelease(
	release: { updateAvailable: boolean; latest: { tag: string } | null } | null
) {
	updateNotice.tag = release?.updateAvailable ? (release.latest?.tag ?? null) : null;
}

export function markUpdateSeen() {
	if (!updateNotice.tag) return;
	updateNotice.seen = updateNotice.tag;
	try {
		localStorage.setItem(SEEN_KEY, updateNotice.tag);
	} catch {
		// Private windows can refuse storage; the dot then returns next visit.
	}
}

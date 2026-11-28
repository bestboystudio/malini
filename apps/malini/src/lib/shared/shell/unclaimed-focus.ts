export { claimFocus, focusFromUser, focusIsUnclaimed } from '$hyper-ui/overlay';

export function overlayIsOpen(): boolean {
	return (
		document.querySelector('[data-dropdown-portal]:not([inert]), [aria-modal="true"]') !== null
	);
}

<script lang="ts">
	import { Button } from '$hyper-ui/components/button';
	import { Icon, type IconName } from '$hyper-ui/icons';

	interface Props {
		count: number;
		kind?: 'requests' | 'unchecked' | 'questions';
		onanswer: () => void;
	}

	let { count, kind = 'requests', onanswer }: Props = $props();

	const COPY = {
		requests: {
			one: 'request needs',
			many: 'requests need',
			source: 'from work this chat started',
			icon: 'dot',
			testId: 'requests-waiting',
		},
		unchecked: {
			one: 'call',
			many: 'calls',
			source: "auto mode's safety check is down (Anthropic)",
			icon: 'shield-alert',
			testId: 'unchecked-calls-waiting',
		},
		questions: {
			one: 'question needs',
			many: 'questions need',
			source: 'held while you typed',
			icon: 'question',
			testId: 'questions-waiting',
		},
	} as const satisfies Record<
		string,
		Readonly<{ one: string; many: string; source: string; icon: IconName; testId: string }>
	>;

	const copy = $derived(COPY[kind]);
	const requests = $derived(
		kind === 'unchecked'
			? `${count} ${count === 1 ? copy.one : copy.many} waiting`
			: `${count} ${count === 1 ? copy.one : copy.many} you`,
	);
</script>

<div class="p-1" data-testid={copy.testId}>
	<Button
		bare
		ariaLabel={`Answer: ${requests}`}
		class="hover:bg-surface-50-hover focus-visible:ring-border-default/50 flex h-7 w-full cursor-pointer items-center gap-2 rounded-xl pr-2 pl-2 text-left text-xs outline-none focus-visible:ring-2"
		onclick={onanswer}
	>
		<span class="text-brand-icon grid size-4 shrink-0 place-items-center" aria-hidden="true">
			<Icon name={copy.icon} size={13} />
		</span>
		<span class="min-w-0 flex-1 truncate">
			<span class="text-fg-default font-medium">{requests}</span>
			<span class="text-fg-tertiary">· {copy.source}</span>
		</span>
		<span class="text-fg-secondary shrink-0">Answer</span>
	</Button>
</div>

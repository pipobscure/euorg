<script lang="ts">
	interface Props {
		value: string; // YYYY-MM-DD
		class?: string;
	}

	let { value = $bindable(""), class: cls = "" }: Props = $props();

	const WEEK_DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
	const MONTH_NAMES = [
		"January", "February", "March", "April", "May", "June",
		"July", "August", "September", "October", "November", "December",
	];

	function pad2(n: number) { return String(n).padStart(2, "0"); }

	function parseDate(v: string): { year: number; month: number; day: number } | null {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
		const [y, m, d] = v.split("-").map(Number);
		return { year: y, month: m - 1, day: d };
	}

	function toYMD(year: number, month: number, day: number): string {
		return `${year}-${pad2(month + 1)}-${pad2(day)}`;
	}

	const today = new Date().toISOString().slice(0, 10);

	// Which month is shown in the popup
	const _p = parseDate(value);
	let navYear = $state(_p?.year ?? new Date().getFullYear());
	let navMonth = $state(_p?.month ?? new Date().getMonth());

	// Keep nav in sync when value changes externally
	$effect(() => {
		const p = parseDate(value);
		if (p) { navYear = p.year; navMonth = p.month; }
	});

	let open = $state(false);
	let btnEl = $state<HTMLButtonElement | undefined>(undefined);
	let popoverEl = $state<HTMLDivElement | undefined>(undefined);
	let popoverStyle = $state("");

	function openPicker() {
		if (!btnEl) return;
		const rect = btnEl.getBoundingClientRect();
		const approxH = 290;
		const spaceBelow = window.innerHeight - rect.bottom - 8;
		const top = spaceBelow >= approxH ? rect.bottom + 4 : rect.top - approxH - 4;
		const left = Math.min(rect.left, window.innerWidth - 252);
		popoverStyle = `top:${top}px;left:${left}px;width:${Math.max(rect.width, 248)}px`;
		open = true;
	}

	function handleOutsideClick(e: MouseEvent) {
		const t = e.target as Node;
		if (btnEl?.contains(t) || popoverEl?.contains(t)) return;
		open = false;
	}

	$effect(() => {
		if (open) {
			document.addEventListener("mousedown", handleOutsideClick);
			return () => document.removeEventListener("mousedown", handleOutsideClick);
		}
	});

	function prevMonth() {
		if (navMonth === 0) { navMonth = 11; navYear--; } else navMonth--;
	}
	function nextMonth() {
		if (navMonth === 11) { navMonth = 0; navYear++; } else navMonth++;
	}

	// Build 42-cell grid (6 rows × 7 cols), Monday-first
	const grid = $derived.by(() => {
		const daysInCur = new Date(navYear, navMonth + 1, 0).getDate();
		const firstDow = new Date(navYear, navMonth, 1).getDay(); // 0=Sun
		const offset = (firstDow + 6) % 7; // Mon=0 … Sun=6

		const prevM = navMonth === 0 ? 11 : navMonth - 1;
		const prevY = navMonth === 0 ? navYear - 1 : navYear;
		const daysInPrev = new Date(prevY, prevM + 1, 0).getDate();

		const nextM = navMonth === 11 ? 0 : navMonth + 1;
		const nextY = navMonth === 11 ? navYear + 1 : navYear;

		const cells: Array<{ date: number; full: string; cur: boolean }> = [];

		for (let i = offset - 1; i >= 0; i--)
			cells.push({ date: daysInPrev - i, full: toYMD(prevY, prevM, daysInPrev - i), cur: false });

		for (let d = 1; d <= daysInCur; d++)
			cells.push({ date: d, full: toYMD(navYear, navMonth, d), cur: true });

		for (let d = 1; cells.length < 42; d++)
			cells.push({ date: d, full: toYMD(nextY, nextM, d), cur: false });

		return cells;
	});

	function selectDay(full: string) {
		value = full;
		open = false;
	}

	const displayValue = $derived.by(() => {
		const p = parseDate(value);
		if (!p) return "";
		return `${pad2(p.day)} ${MONTH_NAMES[p.month].slice(0, 3)} ${p.year}`;
	});
</script>

<!-- Trigger button -->
<div class="relative {cls}">
	<button
		type="button"
		bind:this={btnEl}
		onclick={openPicker}
		class="input w-full text-sm py-1.5 text-left flex items-center gap-2 cursor-pointer select-none"
	>
		<svg class="size-4 shrink-0 text-surface-400-600" viewBox="0 0 20 20" fill="currentColor">
			<path fill-rule="evenodd" d="M5.75 2a.75.75 0 0 1 .75.75V4h7V2.75a.75.75 0 0 1 1.5 0V4h.25A2.75 2.75 0 0 1 18 6.75v8.5A2.75 2.75 0 0 1 15.25 18H4.75A2.75 2.75 0 0 1 2 15.25v-8.5A2.75 2.75 0 0 1 4.75 4H5V2.75A.75.75 0 0 1 5.75 2Zm-1 5.5c-.69 0-1.25.56-1.25 1.25v6.5c0 .69.56 1.25 1.25 1.25h10.5c.69 0 1.25-.56 1.25-1.25v-6.5c0-.69-.56-1.25-1.25-1.25H4.75Z" clip-rule="evenodd"/>
		</svg>
		<span class={value ? "text-surface-900-100" : "text-surface-400"}>
			{displayValue || "Pick a date"}
		</span>
	</button>
</div>

<!-- Popup (fixed, avoids scroll-container clipping) -->
{#if open}
	<div
		bind:this={popoverEl}
		class="fixed z-[9999] rounded-xl border border-surface-200-800 bg-surface-50-950 shadow-2xl p-3"
		style={popoverStyle}
	>
		<!-- Month/year navigation -->
		<div class="flex items-center justify-between mb-2 px-0.5">
			<button type="button" onclick={prevMonth}
				class="p-1.5 rounded-lg hover:bg-surface-100-900 text-surface-500-400">
				<svg class="size-4" viewBox="0 0 20 20" fill="currentColor">
					<path fill-rule="evenodd" d="M11.78 5.22a.75.75 0 0 1 0 1.06L8.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z" clip-rule="evenodd"/>
				</svg>
			</button>
			<span class="text-sm font-semibold text-surface-900-100">
				{MONTH_NAMES[navMonth]} {navYear}
			</span>
			<button type="button" onclick={nextMonth}
				class="p-1.5 rounded-lg hover:bg-surface-100-900 text-surface-500-400">
				<svg class="size-4" viewBox="0 0 20 20" fill="currentColor">
					<path fill-rule="evenodd" d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 1 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd"/>
				</svg>
			</button>
		</div>

		<!-- Weekday headers (Mon – Sun) -->
		<div class="grid grid-cols-7 mb-0.5">
			{#each WEEK_DAYS as d}
				<div class="text-center text-xs font-medium text-surface-400 py-1">{d}</div>
			{/each}
		</div>

		<!-- Day grid -->
		<div class="grid grid-cols-7 gap-px">
			{#each grid as { date, full, cur }}
				<button
					type="button"
					onclick={() => selectDay(full)}
					class="
						aspect-square flex items-center justify-center rounded-lg text-sm leading-none select-none
						{!cur ? 'text-surface-400' : 'text-surface-800-200'}
						{full === value
							? 'bg-primary-500 !text-white font-semibold'
							: full === today
								? 'ring-1 ring-primary-400 hover:bg-surface-100-900'
								: 'hover:bg-surface-100-900'}
					"
				>{date}</button>
			{/each}
		</div>
	</div>
{/if}

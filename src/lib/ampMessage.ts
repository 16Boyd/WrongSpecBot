import { MessageBody } from './discord';

// Shared rendering for the AMP instance status message, used by both the scheduled task
// (real live status) and the interaction handler (the transient "Start Requested" state).

// Fallback description used when a row has no description_template configured.
export const DEFAULT_TEMPLATE = [
    '### Server Stats',
    '**Status:** {status}',
    '**Users:** {userCount}/{maxUsers}'
].join('\n');

// Embed bar colours by status.
export const AMP_COLORS = {
    online: 0x00ff00,   // green
    pending: 0xffcc00,  // yellow (transitional / start requested)
    offline: 0xff0000   // red
};

// Marker an author can place in a template to break the body into side-by-side columns.
// Discord stacks multiple embeds vertically, so true "two embeds side by side" isn't possible;
// instead each chunk between markers becomes an INLINE embed field, and Discord lays inline
// fields out in a row (up to 3 per row), which gives the shorter, two-column look.
export const COLUMN_SEPARATOR = '{split}';

// Discord requires a non-empty field name; a zero-width space gives us a headerless column so
// the author's own `### Heading` inside the value controls what's shown.
const ZERO_WIDTH_SPACE = '​';

export interface AmpMessageParams {
    title: string;
    template: string;
    status: string;     // {status}
    userCount: number;  // {userCount}
    maxUsers: number;   // {maxUsers}
    state: string;      // {state}
    color: number;
    // When set, render a green "Start Server" button targeting this instance; otherwise no button.
    startButtonInstanceId: string | null;
}

// Substitute the supported placeholders in a description template.
export function renderTemplate(
    template: string,
    v: { status: string; userCount: number; maxUsers: number; state: string }
): string {
    return template
        .replace(/\{status\}/g, v.status)
        .replace(/\{userCount\}/g, String(v.userCount))
        .replace(/\{maxUsers\}/g, String(v.maxUsers))
        .replace(/\{state\}/g, v.state);
}

export function buildAmpMessage(p: AmpMessageParams): MessageBody {
    const rendered = renderTemplate(p.template || DEFAULT_TEMPLATE, p);

    // Base embed. If the template has no column marker we keep the single-column description
    // (unchanged behaviour); otherwise we split the body into side-by-side inline fields.
    const embed: Record<string, unknown> = { title: p.title, color: p.color };

    if (rendered.includes(COLUMN_SEPARATOR)) {
        const columns = rendered
            .split(COLUMN_SEPARATOR)
            .map(segment => segment.trim())
            .filter(segment => segment.length > 0)
            // Discord field values cap at 1024 chars; templates are short but clamp defensively.
            .map(segment => ({ name: ZERO_WIDTH_SPACE, value: segment.slice(0, 1024), inline: true }));

        if (columns.length > 0) {
            embed.fields = columns;
        } else {
            embed.description = rendered;
        }
    } else {
        embed.description = rendered;
    }

    return {
        embeds: [embed],
        // Always send a components array so an edit clears the button when it shouldn't show.
        components: p.startButtonInstanceId
            ? [{
                type: 1, // Action row
                components: [{
                    type: 2, // Button
                    style: 3, // Success (green)
                    label: 'Start Server',
                    emoji: { name: '▶️' },
                    custom_id: `amp_start:${p.startButtonInstanceId}`
                }]
            }]
            : []
    };
}

// Fingerprint the rendered message so we only edit Discord when the visible content changes
// (covers live status/player changes AND edits to the template or title in Supabase).
export function ampMessageSignature(body: MessageBody): string {
    return JSON.stringify({ embeds: body.embeds, components: body.components });
}

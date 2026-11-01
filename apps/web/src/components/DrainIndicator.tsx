import { Badge } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useDrainStatus } from '#src/lib/drain.js';

/**
 * Shown on every page while the server drains. A drain outlives the restart it was for, and a board
 * left draining looks healthy while starting nothing. Renders nothing when the status cannot be read,
 * so a key that may not view settings does not get an error in the header.
 */
export function DrainIndicator() {
    const status = useDrainStatus();
    if (!status.data?.draining) return null;

    return (
        <Link to="/settings" style={{ textDecoration: 'none' }}>
            <Badge color="yellow" variant="light" style={{ cursor: 'pointer' }}>
                {status.data.safeToRestart ? 'Safe to restart' : 'Draining'}
            </Badge>
        </Link>
    );
}

// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserMessage } from '#src/components/ChatMessages.js';
import { imagesCaption } from '#src/lib/chat.js';

beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('imagesCaption', () => {
    it('says nothing about a message with no images, and counts the rest', () => {
        expect(imagesCaption(0)).toBe('');
        expect(imagesCaption(1)).toBe('1 image');
        expect(imagesCaption(3)).toBe('3 images');
    });
});

describe('UserMessage', () => {
    const show = (images?: number) => render(createElement(MantineProvider, null, createElement(UserMessage, { text: '', images })));

    it('is not blank when a message is only images', () => {
        show(2);
        expect(screen.getByText('2 images')).toBeTruthy();
    });

    it('adds no caption to a message with none', () => {
        show();
        expect(screen.queryByText(/image/)).toBeNull();
    });
});

import { MemoryHost } from '#tests/support/memory.host.js';

describe('MemoryHost', () => {
    it('keeps writeBytes in bytes, apart from files, and removeTree clears both under the path', async () => {
        const host = new MemoryHost();
        const data = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

        await host.writeBytes('/w/tree/all-bytes.bin', data);
        await host.writeBytes('/w/kept.bin', data);
        await host.writeFile('/w/tree/note.txt', 'x');

        expect(host.bytes.get('/w/tree/all-bytes.bin')?.equals(data)).toBe(true);
        expect(host.files.has('/w/tree/all-bytes.bin')).toBe(false);
        expect([...host.files.keys()]).toEqual(['/w/tree/note.txt']);

        await host.removeTree('/w/tree');

        expect([...host.bytes.keys()]).toEqual(['/w/kept.bin']);
        expect(host.files.size).toBe(0);
    });

    it('stores a copy, so a caller reusing its buffer does not change what was written', async () => {
        const host = new MemoryHost();
        const data = Buffer.from([0xff, 0xfe, 0x80]);

        await host.writeBytes('/w/a.bin', data);
        data.fill(0);

        expect([...host.bytes.get('/w/a.bin')!]).toEqual([0xff, 0xfe, 0x80]);
    });
});

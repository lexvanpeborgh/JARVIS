import { generateImage } from 'ai';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request) {
  try {
    const { prompt } = await request.json();
    if (!prompt || typeof prompt !== 'string') {
      return Response.json({ error: 'Prompt is required' }, { status: 400 });
    }
    const result = await generateImage({
      model: 'openai/gpt-image-2',
      prompt: prompt.slice(0, 5000),
      size: '1024x1024',
    });
    const image = result.images?.[0];
    if (!image) throw new Error('No image returned');
    return Response.json({
      base64: image.base64,
      mediaType: image.mediaType || 'image/png',
    });
  } catch (error) {
    console.error('image-generation', error);
    return Response.json({ error: error?.message || 'Image generation failed' }, { status: 500 });
  }
}

const fetch = require('node-fetch')

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    }
  }

  try {
    const { system, messages, useWebSearch } = JSON.parse(event.body)

    const body = {
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      system,
      messages,
    }

    if (useWebSearch) {
      body.tools = [{
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 3
      }]
      body['anthropic-beta'] = 'web-search-2025-03-05'
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05'
      },
      body: JSON.stringify(body),
    })

    const data = await response.json()
    console.log('Anthropic response:', JSON.stringify(data).slice(0, 500))

    const textContent = data.content
      ?.filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n') || ''

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ ...data, content: [{ type: 'text', text: textContent }] }),
    }
  } catch (err) {
    console.error('Function error:', err)
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message }),
    }
  }
}
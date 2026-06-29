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

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    }

    const body = {
      model: 'claude-sonnet-4-5',
      max_tokens: 800,
      system,
      messages,
    }

    if (useWebSearch) {
      headers['anthropic-beta'] = 'web-search-2025-03-05'
      body.tools = [{
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 2
      }]
      body.max_tokens = 1200
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    const data = await response.json()
    console.log('Status:', response.status)
    console.log('Response:', JSON.stringify(data).slice(0, 500))

    if (data.error && useWebSearch) {
      console.log('Web search failed, retrying without...')
      const body2 = {
        model: 'claude-sonnet-4-5',
        max_tokens: 800,
        system,
        messages,
      }
      const response2 = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body2),
      })
      const data2 = await response2.json()
      const text2 = data2.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') || ''
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ content: [{ type: 'text', text: text2 }] }),
      }
    }

    if (data.error) throw new Error(data.error.message)

    const textContent = data.content
      ?.filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n') || ''

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ content: [{ type: 'text', text: textContent }] }),
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
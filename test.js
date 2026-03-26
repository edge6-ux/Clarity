async function test() {
  const response = await fetch("http://localhost:3000/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: "the Fed raising interest rates" }),
  });

  const data = await response.json();
  console.log(data.result);
}

test();

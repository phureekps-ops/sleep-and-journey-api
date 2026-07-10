require("dotenv").config({ path: ".env.test" });
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
const pool = require("./src/db");
const svc = require("./src/services/catalogService");

async function main() {
  const insertRes = await pool.query(
    "INSERT INTO branches (name, province, region) VALUES ($1, $2, $3) RETURNING id",
    ["Diag Test", "Test", "Test"]
  );
  const branchId = insertRes.rows[0].id;
  try {
    const hotel = await svc.getHotelDetails(branchId, "th");
    console.log("SUCCESS:", JSON.stringify(hotel));
  } catch (err) {
    console.log("ERROR MESSAGE:", err.message);
    console.log("STACK:", err.stack);
  } finally {
    await pool.query("DELETE FROM branches WHERE id = $1", [branchId]);
    await pool.end();
  }
}

main();
import "../lib/cheerio-1.0.0.min.js"

globalThis.chrome = globalThis.browser ? globalThis.browser : globalThis.chrome

async function sendMsg(msg) {
   try {
      await chrome.runtime.sendMessage(msg)
   } catch (error) {
      console.error("Error (sendMsg):", error.message)
   }
}

const getListing = {
   amazon: async ({ key, url, type }) => {
      try {
         const resp = await fetch(`https://www.amazon.in/s?k=${key}&rh=p_n_availability%3A1318485031`)
         const html = await resp.text()
         const $ = cheerio.load(html)
         const listing = $(`div[data-asin=${key}]`)
         if (!listing.length) throw new Error(`Product listing for ${key} doesn't exist.`);
         const title = listing.find("h2").eq(0).text()
         const image = listing.find("img").eq(0).attr("src")
         const price = listing.find("span.a-price-whole").eq(0).text().replace(/,/g, '')
         const inStk = !!price
         const rating = listing.find("div[data-cy='reviews-block'] span[aria-hidden='true']").eq(0).text()
         const ratingCnt = listing.find("div[data-cy='reviews-block'] a[aria-label*='ratings']").eq(0).attr("aria-label").split(" ")[0].replace(/,/g, '')
         const time = Date.now()
         return [{ key, title, type, image, price: { curr: Number(price), last: Number(price) }, inStk, url, time, rating: Number(rating), ratingCnt: Number(ratingCnt)}, null]
      } catch (e) {
         return [null, e.message]
      }
   }, 
   flipkart: async ({ key, url, type }) => {
      try {
         const resp = await fetch(url)
         const html = await resp.text()
         const $ = cheerio.load(html)
         const script = $("script#jsonLD").text()
         const json = JSON.parse(script)[0]
         const title = json.name
         if (!title) throw new Error("Couldn't get product name.");
         const image = json.image[0]
         const price = json.offers?.price
         if (!price) throw new Error("Couldn't get product price.");
         const inStk = json.offers.availability === "https://schema.org/InStock"
         const time = Date.now()
         const rating = json.aggregateRating?.ratingValue
         const ratingCnt = json.aggregateRating?.ratingCount
         return [{ key, title, type, image, price: { curr: Number(price), last: Number(price) }, inStk, url, time, rating: Number(rating), ratingCnt: Number(ratingCnt) }, null]
      } catch (e) {
         return [null, e.message]
      }
   }
}

async function getTabInfo() {
   const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
   const amazonKey = tab?.url?.match(/\/dp\/([\w\d]{10})/i)?.[1] ||
                     tab?.url?.match(/\/gp\/product\/([\w\d]{10})/i)?.[1] // ASIN
   if (amazonKey) {
      return { type: "amazon", key: amazonKey, url: `https://amazon.in/dp/${amazonKey}` }
   }
   const flipkartPid    = tab?.url?.match(/pid\=([\w\d]{0,16})/i)     // pid=XXXXXXXXXXXXXXXX
   const flipkartItmNum = tab?.url?.match(/\/p\/(itm[\w\d]{0,14})/i) // itmXXXXXXXXXXXXXXX
   const flipkartKey    = (flipkartPid ?? flipkartItmNum)?.[1]
   if (flipkartKey) {
      const parsed = new URL(tab.url)
      parsed.hostname = 'https://dl.flipkart.com'
      parsed.searchParams.delete('affid')
      return { type: "flipkart", key: flipkartKey, url: parsed.toString() }
   }
}

async function handleMsg(msg) {
   switch (msg.action) {
      case "AddListing": {
         const { Listings } = await chrome.storage.sync.get(["Listings"])
         const tab = await getTabInfo()
         if (!tab) return await sendMsg({ action: "Error", error: "Not an Amazon/Flipkart product page" });
         if (Listings[tab.key]) return await sendMsg({ action: "Error", error: "Listing already exists" });
         const [listing, err] = await getListing[tab.type](tab)
         if (err) return await sendMsg({ action: "Error", error: err });
         Listings[tab.key] = listing
         console.log("New listing added:", listing)
         await chrome.storage.sync.set({ Listings })
         await sendMsg({ action: "Listings", Listings })
         break
      }
      case "DelListing": {
         const { Listings } = await chrome.storage.sync.get(["Listings"])
         delete Listings[msg.key]
         await chrome.storage.sync.set({ Listings })
         await sendMsg({ action: "Listings", Listings })
         await setBadge(Listings)
         break
      }
      case "RefreshListings": {
         await handleAlarm()
         break
      }
   }
   return true
}

async function sleep(seconds) {
   return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

// copies over values from b for keys in a
function merge(a, b) {
   for (const ak in a) {
      if (b[ak] === undefined) continue;
      a[ak] = b[ak]
   }
   return a
}

async function notify(curr, fresh) {
   if (!curr.inStk && fresh.inStk) {
      await availabilityAlert(curr)
   }
   if (fresh.inStk && fresh.price.curr < curr.price.curr) {
      await priceDropAlert(curr, fresh.price.curr, curr.price.curr)
   }
}

async function refreshAll(Listings) {
   for (const key in Listings) {
      const listing = Listings[key]
      const [fresh, error] = await getListing[listing.type](listing)
      if (error) {
         console.error(`Error refreshing ${key}: `, error)
         continue;
      }
      await notify(listing, fresh)
      if (fresh.inStk && listing.price.curr !== fresh.price.curr) {
         fresh.price.last = listing.price.curr
      }
      Listings[key] = fresh
   }
}

async function availabilityAlert({ key, image, title }) {
   await showNotification("Available now. Hurry!", key, image, title)
} 

async function priceDropAlert({key, image, title}, currPrice, lastPrice) {
   await showNotification(`Price has dropped by ₹${Math.abs(lastPrice - currPrice)}. Now Available at ₹${currPrice}. Hurry!`, key, image, title)
}

function lineClamp(txt) {
   if (txt.length < 50) return txt;
   const words = txt.slice(0, 50).split(" ")
   words.pop()
   return words.join(" ") + "..."
}

async function showNotification(msg, key, image, title) {
   await chrome.notifications.create(key, {
      type: 'basic',
      iconUrl: image,
      title: lineClamp(title),
      message: msg,
      priority: 2
   })
}

async function handleNotification(key) {
   const { Listings } = await chrome.storage.sync.get(["Listings"])
   await chrome.tabs.create({ url: Listings[key].url})
   await chrome.notifications.clear(key)
}

async function setBadge(listings) {
   const num = 
      Object.values(listings)
      .filter((l) => (l.price.curr < l.price.last) &&
                     (l.inStk == true))
      .length
   num == 0 && await chrome.action.setBadgeText({ text: "" });
   num >  0 && await chrome.action.setBadgeText({ text: String(num) });
}

async function handleAlarm() {
   try {
      const { Listings: listings } = await chrome.storage.sync.get(["Listings"])
      if (!listings) return;
   
      await chrome.storage.sync.set({ IsRefreshing: true })
      await sendMsg({ action: "IsRefreshing", IsRefreshing: true })
   
      await refreshAll(listings)
   
      // Taking care of the case where Listings in the storage 
      // might have been updated (deletion or addition) during 
      // refresh was taking place.
      const { Listings } = await chrome.storage.sync.get(["Listings"])
      console.log("Before: ",Listings)
      console.log("Listings from refresh: ", listings)
      merge(Listings, listings)
      console.log("After: ", Listings)

      await chrome.storage.sync.set({ Listings })
      await sendMsg({ action: "Listings", Listings})
      
      await setBadge(Listings)
   } finally {
      await chrome.storage.sync.set({ IsRefreshing: false })
      await sendMsg({ action: "IsRefreshing", IsRefreshing: false })
   }
}

async function setInitialState() {
   const { Listings } = await chrome.storage.sync.get(["Listings"])
   if (!Listings) await chrome.storage.sync.set({ Listings: {} }) 
   await chrome.storage.sync.set({ IsRefreshing: false })
}

async function handleInstall() {
   await setInitialState()
   await handleAlarm()
}

chrome.alarms.get('periodic', (alarm) => (
   !alarm && chrome.alarms.create('periodic', { delayInMinutes: 0, periodInMinutes: 30 })
))
   
// Must register listeners synchronously at global scope of SW or else they won't work
chrome.runtime.onInstalled.addListener(handleInstall)
chrome.runtime.onStartup.addListener(handleAlarm)
chrome.alarms.onAlarm.addListener(handleAlarm)
chrome.runtime.onMessage.addListener(handleMsg)
chrome.notifications.onClicked.addListener(handleNotification)
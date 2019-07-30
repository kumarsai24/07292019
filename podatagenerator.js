function BeforeSubmitRetailPrice()
{
	var po=nlapiNewRecord();
	var prices = {};
    var location=po.getFieldValue('location');
	var exportCurrency=nlapiLookupField('location',location, 'custrecord_tibco_po_export_currency');
	var nlapiLookupField('purchaseorder',1, 'location',);
    var filter=[];
    filter.push(new nlobjSearchFilter('internalid', null, 'anyOf',_.map(EC.po.item, 'item')));
    filter.push(new nlobjSearchFilter('pricing.currency', null, 'is',exportCurrency));
    filter.push(new nlobjSearchFilter('pricing.pricelevel', null, 'is',6));

    var columns = [];
	columns.push(new nlobjSearchColumn('unitprice','pricing'));
	columns.push(new nlobjSearchColumn('internalid'));
	var results=nlapiSearchRecord('item',null,filter,columns).nsSearchResult2obj().toArray().map(function(item) {
  prices[item.internalid] = item.unitprice;
});
_.each(EC.po.item, function(item) {
 item.custcol_us_retail_price = prices[item.item] || '0.00';
});
}




